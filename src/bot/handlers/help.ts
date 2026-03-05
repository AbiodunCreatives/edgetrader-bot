import type { Context } from "grammy";

const HELP_TEXT =
  "🤖 <b>Edge Trader — Command Reference</b>\n\n" +
  "<b>Market Research</b>\n" +
  "• /search &lt;topic&gt; — search Polymarket &amp; Manifold, get AI analysis on any market\n" +
  "• /compare &lt;topic&gt; — find similar markets across platforms and compare them side-by-side with AI\n" +
  "• /picks — today's top 3 AI-picked edge opportunities (refreshed daily at 7 AM)\n\n" +
  "<b>Portfolio &amp; Alerts</b>\n" +
  "• /alert — view your active price alerts; set alerts from any search result\n" +
  "• /portfolio — track positions with entry price, current value, and P&amp;L\n\n" +
  "<b>Group Games</b>\n" +
  "• /game &lt;topic&gt; — start a group prediction game with voting + confidence levels\n" +
  "• /game leaderboard — show group rankings by prediction accuracy\n" +
  "• /game resolve yes|no — close the active game and score all voters\n\n" +
  "<b>Account</b>\n" +
  "• /upgrade — view plans and upgrade to Pro or Whale\n" +
  "• /stats — live platform stats (searches, games, alerts)\n" +
  "• /start — back to the main menu\n\n" +
  "<b>Inline mode</b>\n" +
  "Type <code>@EdgeTraderBot &lt;query&gt;</code> in any chat to search markets without adding me to the group.";

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
}
