import type { Context } from "grammy";
import { getTopMarkets } from "../../services/markets/aggregator.js";
import { generateDailyPicks } from "../../services/ai/analyzer.js";
import { getUserByTelegramId } from "../../db/queries.js";
import { cacheGet, cacheSet } from "../../utils/cache.js";
import { escapeHtml, bold } from "../../utils/format.js";

const PICKS_CACHE_TTL = 24 * 60 * 60; // 24 hours

function todayKey(): string {
  return new Date().toISOString().split("T")[0]!; // "2025-03-01"
}

export async function handlePicks(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  // Determine user tier (free users get upsell)
  const user = await getUserByTelegramId(ctx.from.id);
  const tier = user?.tier ?? "free";

  // Free users get today's picks but see the upsell footer
  const cacheKey = `ai:picks:daily:${todayKey()}`;
  const cached = await cacheGet<string>(cacheKey);

  if (cached) {
    await deliverPicks(ctx, cached, tier);
    return;
  }

  const loading = await ctx.reply("📈 <b>Generating today's picks…</b> This may take a moment.", {
    parse_mode: "HTML",
  });

  try {
    const markets = await getTopMarkets(20); // get 20, let AI pick top 3
    const picks = await generateDailyPicks(markets);
    await cacheSet(cacheKey, picks, PICKS_CACHE_TTL);

    await ctx.api
      .deleteMessage(ctx.chat!.id, loading.message_id)
      .catch(() => null);

    await deliverPicks(ctx, picks, tier);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to generate picks";
    await ctx.api
      .editMessageText(ctx.chat!.id, loading.message_id, `❌ ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      })
      .catch(() => null);
  }
}

async function deliverPicks(ctx: Context, picks: string, tier: string): Promise<void> {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const upsell =
    tier === "free"
      ? `\n\n──────────────────\n🔒 <b>Pro feature:</b> Get today's picks delivered every morning at <b>7 AM</b> automatically. Upgrade to Pro with /upgrade.`
      : "";

  await ctx.reply(
    `📈 <b>Daily Picks — ${escapeHtml(date)}</b>\n\n` +
      `${escapeHtml(picks)}` +
      upsell,
    { parse_mode: "HTML" }
  );
}
