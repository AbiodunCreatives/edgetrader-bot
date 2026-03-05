import type { Context } from "grammy";
import { redis } from "../../utils/rateLimit.js";
import { formatCount } from "../../utils/format.js";

const KEYS = {
  searches: "stats:searches",
  games: "stats:games_started",
  alerts: "stats:alerts_created",
  triggered: "stats:alerts_triggered",
};

export async function handleStats(ctx: Context): Promise<void> {
  try {
    const [searches, games, alerts, triggered] = await redis
      .mget(KEYS.searches, KEYS.games, KEYS.alerts, KEYS.triggered)
      .then((vals) => vals.map((v) => Number(v ?? 0)));

    const body =
      "📊 <b>Edge Trader — Live Stats</b>\n\n" +
      `🔍 Markets searched:   <b>${formatCount(searches)}</b>\n` +
      `🎮 Games started:      <b>${formatCount(games)}</b>\n` +
      `⚡ Alerts created:     <b>${formatCount(alerts)}</b>\n` +
      `🔔 Alerts triggered:   <b>${formatCount(triggered)}</b>`;

    await ctx.reply(body, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[stats] failed to fetch stats:", err);
    await ctx.reply("❌ Couldn't fetch stats. Please try again later.", { parse_mode: "HTML" });
  }
}
