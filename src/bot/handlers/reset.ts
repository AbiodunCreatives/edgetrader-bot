/**
 * /reset — admin-only command to clear a user's rate-limit counters.
 *
 * Usage:
 *   /reset              — resets the admin's own counters
 *   /reset <telegram_id> — resets the specified user's counters
 *
 * Only the Telegram user whose ID matches ADMIN_TELEGRAM_ID in .env can run this.
 */

import type { Context } from "grammy";
import { config } from "../../config.js";
import { resetUserRateLimits } from "../../utils/rateLimit.js";

export async function handleReset(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  // Guard: ADMIN_TELEGRAM_ID must be configured
  if (!config.ADMIN_TELEGRAM_ID) {
    await ctx.reply("⚠️ ADMIN_TELEGRAM_ID is not set in .env — /reset is disabled.", { parse_mode: "HTML" });
    return;
  }

  // Guard: caller must be the admin
  if (ctx.from.id !== config.ADMIN_TELEGRAM_ID) {
    await ctx.reply("🚫 This command is admin-only.", { parse_mode: "HTML" });
    return;
  }

  // Parse optional target telegram_id from command argument
  const arg = ctx.match?.toString().trim();
  let targetId: number;

  if (arg && arg.length > 0) {
    const parsed = Number(arg);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      await ctx.reply("❌ Invalid telegram_id. Usage: <code>/reset</code> or <code>/reset 123456789</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    targetId = parsed;
  } else {
    targetId = ctx.from.id;
  }

  await resetUserRateLimits(targetId);

  await ctx.reply(
    `✅ Rate-limit counters cleared for user <code>${targetId}</code>.\n` +
      `All daily action windows reset; tier cache invalidated.`,
    { parse_mode: "HTML" }
  );

  console.log(`[admin] /reset executed by ${ctx.from.id} for target ${targetId}`);
}
