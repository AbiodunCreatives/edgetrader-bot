/**
 * Central command + callback registration.
 *
 * All bot.command() and bot.callbackQuery() calls live here so the full
 * routing table is visible in one place. Individual handlers are pure
 * functions imported from handlers/.
 *
 * Execution order per incoming update:
 *   1. User upsert middleware (runs on every update, fire-and-forget)
 *   2. Rate-limit check (for rate-limited commands)
 *   3. Command or callback handler
 *   4. Global error handler
 */

import { Bot } from "grammy";
import type { Context } from "grammy";
import { upsertUser } from "../db/queries.js";
import {
  checkRateLimit,
  buildUpgradeCta,
  type RateLimitedAction,
} from "../utils/rateLimit.js";
import { config } from "../config.js";

import { handleStart, handleNavCallback } from "./handlers/start.js";
import {
  handleSearch,
  handleMarketSelect,
  handleMarketAction,
  handleInlineQuery,
} from "./handlers/search.js";
import {
  handleCompare,
  handleCompareSelect,
  handleCompareConfirm,
} from "./handlers/compare.js";
import {
  handleAlert,
  handleAlertSetCondition,
  handleAlertSetThreshold,
  handleAlertDelete,
} from "./handlers/alert.js";
import { handlePortfolio } from "./handlers/portfolio.js";
import { handlePicks } from "./handlers/picks.js";
import { handleGame, handleGameVote } from "./handlers/game.js";
import { handleUpgrade } from "./handlers/upgrade.js";
import { handleReset } from "./handlers/reset.js";
import { handleHelp } from "./handlers/help.js";
import { handleStats } from "./handlers/stats.js";

export function registerCommands(bot: Bot): void {
  // ── Middleware: ensure every interacting user exists in DB ──────────────
  bot.use(async (ctx: Context, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      upsertUser(ctx.from.id, ctx.from.username).catch((err) =>
        console.error("[bot:middleware] upsertUser failed:", err)
      );
    }
    await next();
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  bot.command(["start"], wrap(handleStart));
  bot.command("help",     wrap(handleHelp));
  bot.command("search",    withRateLimit("search",    handleSearch));
  bot.command("compare",   withRateLimit("compare",   handleCompare));
  bot.command("picks",     withRateLimit("picks",     handlePicks));
  bot.command("game",      withRateLimit("game",      handleGame));
  bot.command("portfolio", withRateLimit("portfolio", handlePortfolio));
  // Alert command: rate-limit on creation is enforced inside the handler
  // (quota is "max N active alerts", not a daily window).
  bot.command("alert",   wrap(handleAlert));
  bot.command("upgrade", wrap(handleUpgrade));
  bot.command("reset",   wrap(handleReset));
  bot.command("stats",   wrap(handleStats));

  // ── Callback queries ──────────────────────────────────────────────────────

  // /start inline navigation buttons
  bot.callbackQuery(/^nav:/, wrap(handleNavCallback));

  // Search flow:  ms:{idx}  →  market selected
  bot.callbackQuery(/^ms:\d+$/, wrap(handleMarketSelect));
  // Market action buttons: ma:{alert|port|refresh|back}:{idx}
  bot.callbackQuery(/^ma:/, wrap(handleMarketAction));

  // Compare flow
  bot.callbackQuery(/^cmp:sel:/, wrap(handleCompareSelect));
  bot.callbackQuery("cmp:go",    wrap(handleCompareConfirm));

  // Alert creation flow
  bot.callbackQuery(/^als:/, wrap(handleAlertSetCondition)); // condition chosen
  bot.callbackQuery(/^alt:/, wrap(handleAlertSetThreshold)); // threshold chosen
  bot.callbackQuery(/^ald:/, wrap(handleAlertDelete));       // delete button

  // Game votes: gv:{y|n}:{shortId}:{confidence}
  bot.callbackQuery(/^gv:/, wrap(handleGameVote));

  // Inline mode search
  bot.inlineQuery(/.*/, wrapInline(handleInlineQuery));

  // ── Global error handler ─────────────────────────────────────────────────
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[bot] Unhandled error for update ${ctx.update.update_id}:`, err.error);

    ctx
      .reply("❌ Something went wrong. Please try again in a moment.")
      .catch(() => null);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wraps a handler to catch and log any thrown errors without crashing the bot.
 * Sends a user-friendly error message when possible.
 */
function wrap(
  handler: (ctx: Context) => Promise<void>
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    // Answer callback query immediately so the spinner always clears,
    // even if the handler crashes before it gets a chance to answer.
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => null);
    }

    const updateId = ctx.update.update_id;
    const handlerName = handler.name || "(anonymous)";
    console.log(`[bot:wrap] update=${updateId} handler=${handlerName}`);
    try {
      await handler(ctx);
      console.log(`[bot:wrap] update=${updateId} handler=${handlerName} — done`);
    } catch (err) {
      console.error(`[bot:wrap] update=${updateId} handler=${handlerName} — caught error:`, err);
      await ctx
        .reply("❌ Something went wrong, please try again.", { parse_mode: "HTML" })
        .catch((e) => console.error("[bot:wrap] reply failed:", e));
    }
  };
}

/** Inline query wrapper with friendly error handling. */
function wrapInline(
  handler: (ctx: Context) => Promise<void>
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    const updateId = ctx.update.update_id;
    const handlerName = handler.name || "(anonymous)";
    try {
      await handler(ctx);
      console.log(`[bot:inline] update=${updateId} handler=${handlerName} — done`);
    } catch (err) {
      console.error(`[bot:inline] update=${updateId} handler=${handlerName} — caught error:`, err);
      await ctx.answerInlineQuery([], { cache_time: 5 }).catch(() => null);
    }
  };
}

/**
 * Combines the error-catching wrap() with a tier-aware rate-limit check.
 * If the user has hit their daily limit for `action`, replies with an upgrade
 * CTA and skips the handler entirely.
 */
function withRateLimit(
  action: RateLimitedAction,
  handler: (ctx: Context) => Promise<void>
): (ctx: Context) => Promise<void> {
  return wrap(async (ctx: Context) => {
    if (!ctx.from) {
      console.warn(`[bot:rateLimit] ${action} — ctx.from is null, skipping`);
      return;
    }

    // Admin bypass — skip rate limiting entirely
    if (config.ADMIN_TELEGRAM_ID && ctx.from.id === config.ADMIN_TELEGRAM_ID) {
      await handler(ctx);
      return;
    }

    console.log(`[bot:rateLimit] ${action} check for user ${ctx.from.id}`);
    const result = await checkRateLimit(ctx.from.id, action);
    console.log(`[bot:rateLimit] ${action} result: allowed=${result.allowed} tier=${result.tier} remaining=${result.remaining}`);

    if (!result.allowed) {
      const cta = buildUpgradeCta(action, result.tier);
      await ctx.reply(cta, { parse_mode: "HTML" });
      return;
    }

    await handler(ctx);
  });
}
