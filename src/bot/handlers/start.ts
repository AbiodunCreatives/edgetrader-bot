import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { bold, escapeHtml } from "../../utils/format.js";

export async function handleStart(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const isGroup = ctx.chat?.type !== "private";
  const name = bold(escapeHtml(ctx.from.first_name ?? "there"));

  if (isGroup) {
    await ctx.reply(
      `👋 I'm <b>Edge Trader</b> — your AI prediction market analyst!\n\n` +
        `📊 Use <code>/search [topic]</code> to find markets\n` +
        `🎮 Use <code>/game [topic]</code> to start a group prediction game\n` +
        `🏆 Use <code>/game leaderboard</code> to see rankings`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const kb = new InlineKeyboard()
    .text("🔍 Search Markets", "nav:search")
    .text("📈 Daily Picks", "nav:picks")
    .row()
    .text("⚡ My Alerts", "nav:alerts")
    .text("💼 Portfolio", "nav:portfolio")
    .row()
    .text("❓ Help", "nav:help");

  await ctx.reply(
    `👋 Hey ${name}! Welcome to <b>Edge Trader</b>.\n\n` +
      `I'm your AI-powered prediction market analyst. I track Polymarket &amp; Bayse in real-time and use Claude to find edges.\n\n` +
      `<b>What I can do:</b>\n` +
      `• <code>/search &lt;topic&gt;</code> — find &amp; analyse markets\n` +
      `• <code>/compare &lt;topic&gt;</code> — compare markets side-by-side\n` +
      `• <code>/picks</code> — today's top AI-picked opportunities\n` +
      `• <code>/alert</code> — set price alerts\n` +
      `• <code>/portfolio</code> — track your positions\n` +
      `• <code>/game &lt;topic&gt;</code> — group prediction game\n\n` +
      `Where do you want to start?`,
    { parse_mode: "HTML", reply_markup: kb }
  );
}

/** Handles nav:* inline keyboard buttons from the /start message. */
export async function handleNavCallback(ctx: Context): Promise<void> {
  const action = (ctx.callbackQuery?.data ?? "").slice(4); // strip "nav:"
  await ctx.answerCallbackQuery().catch(() => null);

  const instructions: Record<string, string> = {
    search:
      `🔍 <b>Search Markets</b>\n\n` +
      `Send: <code>/search &lt;topic&gt;</code>\n\n` +
      `Examples:\n` +
      `• <code>/search US election</code>\n` +
      `• <code>/search bitcoin price</code>\n` +
      `• <code>/search AI regulation</code>`,
    picks:
      `📈 <b>Daily Picks</b>\n\nSend <code>/picks</code> to get today's AI-generated edge opportunities.`,
    alerts:
      `⚡ <b>Price Alerts</b>\n\nSend <code>/alert</code> to see your active alerts.\n\nTo set a new alert, find a market with <code>/search</code> and tap <b>Set Alert</b>.`,
    portfolio:
      `💼 <b>Portfolio</b>\n\nSend <code>/portfolio</code> to view your positions.\n\nTo add: <code>/portfolio add &lt;market_id&gt; &lt;yes|no&gt; &lt;price&gt; &lt;qty&gt;</code>`,
    help:
      `❓ <b>Help</b>\n\n` +
      `<b>Commands:</b>\n` +
      `• /search &lt;topic&gt;\n• /compare &lt;topic&gt;\n• /picks\n• /alert\n• /portfolio\n• /game &lt;topic&gt;\n\n` +
      `For support, contact @EdgeTraderSupport`,
  };

  const text = instructions[action] ?? "Use the commands above to get started!";
  await ctx.editMessageText(text, { parse_mode: "HTML" }).catch(() =>
    ctx.reply(text, { parse_mode: "HTML" })
  );
}
