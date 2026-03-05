/**
 * Telegram notification sender for the alert system.
 *
 * Uses grammy's low-level Api class so the notifier can be called from
 * background cron jobs without needing a full bot context.
 *
 * "View Market" is a URL button (opens in browser).
 * "Set New Alert" pre-loads the market into the user's Redis session and
 * uses the ms:0 callback so the existing search → analysis → alert flow
 * handles the rest without any extra state machine.
 */

import { Api, InlineKeyboard } from "grammy";
import { config } from "../../config.js";
import { saveSearchResults } from "../../bot/session.js";
import { escapeHtml, formatProbability, formatVolume } from "../../utils/format.js";
import type { MarketData } from "../markets/types.js";
import type { DbAlertWithUser } from "../../db/queries.js";
import { redis } from "../../utils/rateLimit.js";

// Single shared Api instance — thread-safe, stateless
const tgApi = new Api(config.BOT_TOKEN);

// ── Alert notification ─────────────────────────────────────────────────────

export async function sendAlert(
  alert: DbAlertWithUser,
  market: MarketData
): Promise<void> {
  const { telegram_id, condition, threshold } = alert;

  const currentPct = ((market.probability ?? 0) * 100).toFixed(1);
  const thresholdPct = threshold.toFixed(1);

  const conditionLine =
    condition === "above"
      ? `📈 Goes <b>above ${thresholdPct}%</b>`
      : condition === "below"
        ? `📉 Goes <b>below ${thresholdPct}%</b>`
        : `📊 <b>Volume spike</b> detected`;

  const closesLine = market.endDate
    ? `📅 Closes: ${new Date(market.endDate).toDateString()}`
    : "";

  const text =
    `🔔 <b>ALERT TRIGGERED</b>\n\n` +
    `<b>${escapeHtml(market.question)}</b>\n\n` +
    `Condition: ${conditionLine}\n` +
    `Current:   <b>${currentPct}%</b>\n` +
    `Volume:    ${formatVolume(market.volume)}\n` +
    (closesLine ? `${closesLine}\n` : "");

  // Pre-load this market as search result [0] so "Set New Alert" works
  // by re-using the existing ms:0 → market-select → alert-button flow.
  await saveSearchResults(telegram_id, [market]);

  const kb = new InlineKeyboard()
    .url("📊 View Market", market.url)
    .text("⚡ Set New Alert", "ms:0");

  await tgApi.sendMessage(telegram_id, text.trimEnd(), {
    parse_mode: "HTML",
    reply_markup: kb,
  });
  void redis.incr("stats:alerts_triggered").catch(() => null);
}

// ── Daily picks broadcast ──────────────────────────────────────────────────

export async function sendDailyPicks(telegramId: number, picks: string): Promise<void> {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  await tgApi.sendMessage(
    telegramId,
    `📈 <b>Daily Picks — ${escapeHtml(date)}</b>\n\n` +
      `${escapeHtml(picks)}\n\n` +
      `<i>Delivered every morning at 7 AM UTC for Pro &amp; Whale members.</i>\n` +
      `Use /picks at any time to see the latest picks.`,
    { parse_mode: "HTML" }
  );
}
