import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { searchAllMarkets } from "../../services/markets/aggregator.js";
import { analyzeMarket } from "../../services/ai/analyzer.js";
import { formatProbability, formatVolume, probBar, escapeHtml, bold } from "../../utils/format.js";
import {
  saveSearchResults,
  getSearchResults,
  saveActiveMarket,
  saveAlertState,
} from "../session.js";
import type { MarketData } from "../../services/markets/types.js";

const MAX_LABEL_LEN = 38;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function marketListKeyboard(markets: MarketData[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  markets.slice(0, 5).forEach((m, i) => {
    const pct = ((m.probability ?? 0) * 100).toFixed(0);
    const label = `📊 ${truncate(m.question, MAX_LABEL_LEN)} (${pct}%)`;
    kb.text(label, `ms:${i}`).row();
  });
  return kb;
}

function analysisKeyboard(idx: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Set Alert", `ma:alert:${idx}`)
    .text("💼 Add to Portfolio", `ma:port:${idx}`)
    .row()
    .text("🔄 Refresh Analysis", `ma:refresh:${idx}`)
    .text("🔍 Back to Results", `ma:back:${idx}`);
}

function formatMarketCard(m: MarketData): string {
  const src = m.source === "polymarket" ? "Polymarket" : "Bayse";
  const bar = probBar(m.probability);
  const vol = formatVolume(m.volume);
  const closes = m.endDate
    ? `Closes: ${new Date(m.endDate).toDateString()}`
    : "No end date";
  return (
    `${bold(escapeHtml(m.question))}\n\n` +
    `${bar} <b>${formatProbability(m.probability)}</b> YES\n\n` +
    `📦 Volume: ${vol}   🏛 ${src}\n` +
    `📅 ${closes}\n` +
    `🔗 <a href="${m.url}">View market</a>`
  );
}

// ── /search handler ────────────────────────────────────────────────────────

export async function handleSearch(ctx: Context): Promise<void> {
  console.log(`[search] handleSearch entry — user=${ctx.from?.id} chat=${ctx.chat?.id}`);
  if (!ctx.from) {
    console.warn("[search] handleSearch — ctx.from is null, aborting");
    return;
  }

  const query = (ctx.message?.text ?? "").split(" ").slice(1).join(" ").trim();
  if (!query) {
    await ctx.reply("🔍 Usage: <code>/search &lt;topic&gt;</code>\n\nExample: <code>/search US election 2025</code>", {
      parse_mode: "HTML",
    });
    return;
  }

  console.log(`[search] query="${query}" — sending loading message`);
  const loading = await ctx.reply(`🔍 Searching for <b>${escapeHtml(query)}</b>…`, {
    parse_mode: "HTML",
  });

  try {
    console.log(`[search] calling searchAllMarkets("${query}")`);
    const markets = await searchAllMarkets(query, 10);

    if (markets.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ No markets found for "<b>${escapeHtml(query)}</b>".\n\nTry broader terms — e.g. "election" instead of "2025 US presidential".`,
        { parse_mode: "HTML" }
      );
      return;
    }

    console.log(`[search] searchAllMarkets returned ${markets.length} result(s)`);
    await saveSearchResults(ctx.from.id, markets);

    const count = markets.length;
    const header = `🔍 Found <b>${count}</b> market${count !== 1 ? "s" : ""} for "<b>${escapeHtml(query)}</b>". Tap one to analyse:`;

    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, header, {
      parse_mode: "HTML",
      reply_markup: marketListKeyboard(markets),
    });
  } catch (err) {
    console.error("[search] handleSearch error:", err);
    const msg = err instanceof Error ? err.message : "Search failed";
    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, `❌ ${escapeHtml(msg)}`, {
      parse_mode: "HTML",
    }).catch((e) => console.error("[search] editMessageText (error) failed:", e));
  }
}

// ── ms:{idx} — user tapped a market from search results ───────────────────

export async function handleMarketSelect(ctx: Context): Promise<void> {
  console.log(`[search] handleMarketSelect entry — user=${ctx.from?.id} data=${ctx.callbackQuery?.data}`);
  if (!ctx.from || !ctx.callbackQuery) return;
  await ctx.answerCallbackQuery("Analysing market…").catch(() => null);

  const data = ctx.callbackQuery.data ?? "";
  const idx = parseInt(data.slice(3), 10); // strip "ms:"

  const markets = await getSearchResults(ctx.from.id);
  if (!markets || !markets[idx]) {
    await ctx.editMessageText("❌ Search results expired. Run /search again.", { parse_mode: "HTML" }).catch(() => null);
    return;
  }

  const market = markets[idx];
  await saveActiveMarket(ctx.from.id, market);

  await ctx.editMessageText(
    `${formatMarketCard(market)}\n\n⏳ <i>Generating AI analysis…</i>`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
  ).catch(() => null);

  try {
    const analysis = await analyzeMarket(market);
    const body =
      `${formatMarketCard(market)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 <b>Edge Trader Analysis</b>\n\n` +
      `${escapeHtml(analysis)}`;

    await ctx.editMessageText(body, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: analysisKeyboard(idx),
    }).catch(() => null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Analysis failed";
    await ctx.editMessageText(
      `${formatMarketCard(market)}\n\n❌ Analysis unavailable: ${escapeHtml(msg)}`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: analysisKeyboard(idx),
      }
    ).catch(() => null);
  }
}

// ── ma:{action}:{idx} — action buttons below an analysis ──────────────────

export async function handleMarketAction(ctx: Context): Promise<void> {
  console.log(`[search] handleMarketAction entry — user=${ctx.from?.id} data=${ctx.callbackQuery?.data}`);
  if (!ctx.from || !ctx.callbackQuery) return;

  const data = ctx.callbackQuery.data ?? "";
  const parts = data.split(":");
  const action = parts[1];          // "alert" | "port" | "refresh" | "back"
  const idx = parseInt(parts[2] ?? "0", 10);

  const markets = await getSearchResults(ctx.from.id);
  const market = markets?.[idx];

  if (!market) {
    await ctx.answerCallbackQuery("Session expired — run /search again.").catch(() => null);
    return;
  }

  switch (action) {
    case "alert": {
      await ctx.answerCallbackQuery().catch(() => null);
      // Save state for the alert flow, then ask for condition
      await saveAlertState(ctx.from.id, {
        marketId: `${market.source}:${market.id}`,
        marketQuestion: market.question,
      });
      const kb = new InlineKeyboard()
        .text("📈 Goes ABOVE", `als:above`)
        .text("📉 Goes BELOW", `als:below`);
      await ctx.reply(
        `⚡ <b>Set Alert</b>\n\n<i>${escapeHtml(truncate(market.question, 60))}</i>\n\nNotify me when the probability:`,
        { parse_mode: "HTML", reply_markup: kb }
      );
      break;
    }

    case "port": {
      await ctx.answerCallbackQuery().catch(() => null);
      const compositeId = `${market.source}:${market.id}`;
      await ctx.reply(
        `💼 <b>Add to Portfolio</b>\n\n<i>${escapeHtml(truncate(market.question, 60))}</i>\n\n` +
          `Use this command to add your position:\n` +
          `<code>/portfolio add ${compositeId} yes|no &lt;entry_price&gt; &lt;quantity&gt;</code>\n\n` +
          `Example (100 shares of YES at 65¢):\n` +
          `<code>/portfolio add ${compositeId} yes 0.65 100</code>`,
        { parse_mode: "HTML" }
      );
      break;
    }

    case "refresh": {
      await ctx.answerCallbackQuery("Refreshing analysis…").catch(() => null);
      try {
        const analysis = await analyzeMarket(market);
        const body =
          `${formatMarketCard(market)}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🤖 <b>Edge Trader Analysis</b>\n\n` +
          `${escapeHtml(analysis)}`;
        await ctx.editMessageText(body, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: analysisKeyboard(idx),
        }).catch(() => null);
      } catch (err) {
        await ctx.answerCallbackQuery("Analysis failed — try again later.").catch(() => null);
      }
      break;
    }

    case "back": {
      await ctx.answerCallbackQuery().catch(() => null);
      const count = markets?.length ?? 0;
      await ctx.editMessageText(
        `🔍 Showing <b>${count}</b> result${count !== 1 ? "s" : ""}. Tap a market to analyse:`,
        {
          parse_mode: "HTML",
          reply_markup: marketListKeyboard(markets ?? []),
        }
      ).catch(() => null);
      break;
    }

    default:
      await ctx.answerCallbackQuery().catch(() => null);
  }
}
