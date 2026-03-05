/**
 * /upgrade — show tier comparison and upgrade instructions.
 *
 * V1: No payment integration. Users DM the admin to get upgraded.
 * After the admin runs /admin upgrade <telegram_id> pro (or similar),
 * the tier change is written to the DB and the tier cache is invalidated.
 */

import type { Context } from "grammy";
import { getRemainingQuota } from "../../utils/rateLimit.js";
import { escapeHtml } from "../../utils/format.js";

// Change this to your actual Telegram handle
const ADMIN_HANDLE = "@biodunCrypt";

function quota(used: number, limit: number | null): string {
  if (limit === null) return "✅ Unlimited";
  const remaining = Math.max(0, limit - used);
  return remaining > 0 ? `${remaining}/${limit} left today` : `⛔ 0/${limit} (reset in 24 h)`;
}

export async function handleUpgrade(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  let q;
  try {
    q = await getRemainingQuota(ctx.from.id);
  } catch {
    // If quota fetch fails, show the plan list without live usage
    q = null;
  }

  const tier = q?.tier ?? "free";
  const tierLabel =
    tier === "whale" ? "🏆 Whale" : tier === "pro" ? "⚡ Pro" : "🆓 Free";

  // ── Tier comparison sections ─────────────────────────────────────────────

  const tierSections =
    `🆓 <b>Free</b>\n` +
    `• 10 searches / day\n` +
    `• 10 compares / day\n` +
    `• 3 AI picks / day\n` +
    `• ❌ Morning picks delivery\n` +
    `• 1 prediction game / day\n` +
    `• ❌ Portfolio tracker\n` +
    `• Max 3 alerts\n` +
    `• ❌ Priority AI queue\n` +
    `\n` +
    `⚡ <b>Pro — $9/mo</b>\n` +
    `• ✅ Unlimited searches\n` +
    `• ✅ Unlimited compares\n` +
    `• ✅ Unlimited AI picks\n` +
    `• ✅ Morning picks at 7 AM UTC\n` +
    `• ✅ Unlimited prediction games\n` +
    `• ✅ Portfolio tracker\n` +
    `• Max 20 alerts\n` +
    `• ❌ Priority AI queue\n` +
    `\n` +
    `🏆 <b>Whale — $29/mo</b>\n` +
    `• ✅ Unlimited searches\n` +
    `• ✅ Unlimited compares\n` +
    `• ✅ Unlimited AI picks\n` +
    `• ✅ Morning picks at 7 AM UTC\n` +
    `• ✅ Unlimited prediction games\n` +
    `• ✅ Portfolio tracker\n` +
    `• ✅ Unlimited alerts\n` +
    `• ✅ Priority AI queue\n`;

  // ── Live usage (if available) ────────────────────────────────────────────

  const usageSection = q
    ? `\n📊 <b>Your usage today</b> (${tierLabel}):\n` +
      `• Searches:  ${quota(q.search.used,  q.search.limit)}\n` +
      `• Compares:  ${quota(q.compare.used, q.compare.limit)}\n` +
      `• AI Picks:  ${quota(q.picks.used,   q.picks.limit)}\n` +
      `• Games:     ${quota(q.game.used,    q.game.limit)}\n` +
      `• Portfolio: ${q.portfolio ? "✅ Enabled" : "❌ Upgrade to unlock"}\n` +
      `• Alerts:    max ${q.alertMax ?? "unlimited"}\n`
    : "";

  // ── Upgrade call-to-action ───────────────────────────────────────────────

  const ctaSection =
    tier === "whale"
      ? `\n🏆 You're on the <b>Whale</b> plan — maximum access enabled!`
      : tier === "pro"
        ? `\n⚡ You're on the <b>Pro</b> plan!\n\nWant Whale access (unlimited alerts + priority AI)?\n` +
          `DM ${escapeHtml(ADMIN_HANDLE)} to upgrade.`
        : `\n💳 <b>Ready to upgrade?</b>\n\n` +
          `Payment integration is coming soon. For now, DM ${escapeHtml(ADMIN_HANDLE)} ` +
          `with your Telegram ID (<code>${ctx.from.id}</code>) to get upgraded manually.\n\n` +
          `Your plan will be updated within 24 hours.`;

  await ctx.reply(
    `🚀 <b>Edge Trader Plans</b>\n\n` +
      tierSections +
      usageSection +
      ctaSection,
    { parse_mode: "HTML" }
  );
}
