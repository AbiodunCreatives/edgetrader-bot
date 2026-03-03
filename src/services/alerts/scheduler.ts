/**
 * Background cron jobs.
 *
 * Job 1 — Alert checker (every 5 minutes, UTC):
 *   Fetches all un-triggered alerts + their owner's telegram_id in one query,
 *   groups them by market to avoid duplicate API calls, checks each condition,
 *   marks triggered alerts in the DB, and calls notifier.sendAlert().
 *
 * Job 2 — Daily picks broadcast (07:00 UTC):
 *   Generates (or reads from cache) today's AI picks, then sends them to
 *   every Pro and Whale user. Free-tier users get the picks on-demand via
 *   /picks but don't receive the morning push.
 *
 * Both jobs use `noOverlap: true` so slow market fetches or a large user base
 * never cause two instances to run concurrently.
 */

import nodeCron from "node-cron";
import {
  getActiveAlertsWithUsers,
  markAlertTriggered,
  getUsersByTier,
  type DbAlertWithUser,
} from "../../db/queries.js";
import {
  getMarketById,
  getTopMarkets,
} from "../markets/aggregator.js";
import { generateDailyPicks } from "../ai/analyzer.js";
import { sendAlert, sendDailyPicks } from "./notifier.js";
import { redis } from "../../utils/rateLimit.js";
import { cacheGet, cacheSet } from "../../utils/cache.js";
import type { MarketData } from "../markets/types.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Volume must grow by this factor between checks to fire a volume_spike alert. */
const VOLUME_SPIKE_RATIO = 1.5;

/** ms between outbound Telegram messages to respect per-chat rate limits. */
const SEND_DELAY_MS = 150; // ~6 msg/s, well under Telegram's 30/s global limit

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayUtc(): string {
  return new Date().toISOString().split("T")[0]!; // "YYYY-MM-DD"
}

// ── Condition evaluation ───────────────────────────────────────────────────

/**
 * Returns true if the alert's condition is currently met.
 * For volume_spike: compares current volume against the last recorded value
 * stored in Redis. Updates the stored value on every call so the baseline
 * always reflects the most recent check.
 */
async function conditionMet(alert: DbAlertWithUser, market: MarketData): Promise<boolean> {
  const currentPct = market.probability * 100;

  switch (alert.condition) {
    case "above":
      return currentPct > alert.threshold;

    case "below":
      return currentPct < alert.threshold;

    case "volume_spike": {
      const prevKey = `vol:prev:${alert.market_id}`;
      const prevRaw = await redis.get(prevKey);
      const prevVol = prevRaw !== null ? parseFloat(prevRaw) : null;

      // Store current volume; TTL = 7 days (covers weekly markets)
      await redis.set(prevKey, String(market.volume), "EX", 7 * 24 * 3600);

      // No baseline yet → record it now, fire on the next check
      if (prevVol === null) return false;

      return market.volume > prevVol * VOLUME_SPIKE_RATIO;
    }

    default:
      return false;
  }
}

// ── Job 1: Alert checker ───────────────────────────────────────────────────

async function runAlertCheck(): Promise<void> {
  console.log("[scheduler:alerts] Starting check…");

  let alerts: DbAlertWithUser[];
  try {
    alerts = await getActiveAlertsWithUsers();
  } catch (err) {
    console.error("[scheduler:alerts] DB fetch failed:", err);
    return;
  }

  if (alerts.length === 0) {
    console.log("[scheduler:alerts] No active alerts — done.");
    return;
  }

  console.log(`[scheduler:alerts] Checking ${alerts.length} alert(s)…`);

  // Group by composite market_id so each market is fetched exactly once
  const byMarket = new Map<string, DbAlertWithUser[]>();
  for (const alert of alerts) {
    const bucket = byMarket.get(alert.market_id) ?? [];
    bucket.push(alert);
    byMarket.set(alert.market_id, bucket);
  }

  let triggered = 0;
  let fetchErrors = 0;
  let sendErrors = 0;

  for (const [marketId, marketAlerts] of byMarket) {
    let market: MarketData | null;
    try {
      market = await getMarketById(marketId);
    } catch (err) {
      console.error(`[scheduler:alerts] Failed to fetch ${marketId}:`, err);
      fetchErrors++;
      continue;
    }

    if (!market) {
      console.warn(`[scheduler:alerts] Market not found: ${marketId} — skipping ${marketAlerts.length} alert(s)`);
      continue;
    }

    for (const alert of marketAlerts) {
      try {
        const fire = await conditionMet(alert, market);
        if (!fire) continue;

        // Mark first so a send failure doesn't cause double-fires
        await markAlertTriggered(alert.id);
        await sendAlert(alert, market);
        triggered++;

        console.log(
          `[scheduler:alerts] Fired alert ${alert.id} → user ${alert.telegram_id} ` +
            `(${alert.condition} ${alert.threshold}% on ${marketId})`
        );

        await sleep(SEND_DELAY_MS);
      } catch (err) {
        console.error(`[scheduler:alerts] Error on alert ${alert.id}:`, err);
        sendErrors++;
      }
    }
  }

  console.log(
    `[scheduler:alerts] Done — triggered: ${triggered}, ` +
      `fetch errors: ${fetchErrors}, send errors: ${sendErrors}`
  );
}

// ── Job 2: Daily picks broadcast ──────────────────────────────────────────

async function runDailyPicks(): Promise<void> {
  console.log("[scheduler:picks] Starting daily picks broadcast…");

  const cacheKey = `ai:picks:daily:${todayUtc()}`;

  // Reuse picks if already generated (e.g. someone already ran /picks today)
  let picks = await cacheGet<string>(cacheKey);

  if (!picks) {
    console.log("[scheduler:picks] No cached picks — generating…");
    try {
      const markets = await getTopMarkets(20);
      picks = await generateDailyPicks(markets);
      await cacheSet(cacheKey, picks, 24 * 60 * 60);
      console.log("[scheduler:picks] Picks generated and cached.");
    } catch (err) {
      console.error("[scheduler:picks] Failed to generate picks:", err);
      return;
    }
  } else {
    console.log("[scheduler:picks] Using cached picks.");
  }

  let users: Awaited<ReturnType<typeof getUsersByTier>>;
  try {
    users = await getUsersByTier(["pro", "whale"]);
  } catch (err) {
    console.error("[scheduler:picks] Failed to fetch users:", err);
    return;
  }

  console.log(`[scheduler:picks] Sending to ${users.length} Pro/Whale user(s)…`);

  let sent = 0;
  let blocked = 0;
  let errors = 0;

  for (const user of users) {
    try {
      await sendDailyPicks(user.telegram_id, picks);
      sent++;
      await sleep(SEND_DELAY_MS);
    } catch (err: unknown) {
      // 403 = user blocked the bot — expected, not an error we can fix
      const code = (err as { error_code?: number }).error_code;
      if (code === 403) {
        blocked++;
        console.log(`[scheduler:picks] User ${user.telegram_id} has blocked the bot.`);
      } else {
        errors++;
        console.error(`[scheduler:picks] Failed to send to ${user.telegram_id}:`, err);
      }
    }
  }

  console.log(
    `[scheduler:picks] Done — sent: ${sent}, blocked: ${blocked}, errors: ${errors}`
  );
}

// ── Entry point ────────────────────────────────────────────────────────────

export function startScheduler(): void {
  nodeCron.schedule("*/5 * * * *", runAlertCheck, {
    name: "alert-checker",
    noOverlap: true,  // prevents overlap if a check takes longer than 5 min
    timezone: "UTC",
  });

  nodeCron.schedule("0 7 * * *", runDailyPicks, {
    name: "daily-picks",
    noOverlap: true,
    timezone: "UTC",
  });

  console.log(
    "[scheduler] Started:\n" +
      "  • alert-checker  — every 5 minutes (UTC)\n" +
      "  • daily-picks    — 07:00 UTC daily"
  );
}
