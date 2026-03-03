import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { searchAllMarkets } from "../../services/markets/aggregator.js";
import { compareMarkets as aiCompare } from "../../services/ai/analyzer.js";
import { escapeHtml, bold, formatProbability, formatVolume } from "../../utils/format.js";
import { saveCompareSession, getCompareSession } from "../session.js";
import type { MarketData } from "../../services/markets/types.js";

const MAX_SELECTIONS = 4;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function selectionKeyboard(markets: MarketData[], selections: number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  markets.slice(0, 6).forEach((m, i) => {
    const tick = selections.includes(i) ? "✅ " : "";
    const label = `${tick}${truncate(m.question, 36)}`;
    kb.text(label, `cmp:sel:${i}`).row();
  });

  const canCompare = selections.length >= 2;
  kb.text(
    canCompare
      ? `🔍 Compare ${selections.length} markets`
      : `Select at least 2 markets…`,
    "cmp:go"
  );
  return kb;
}

// ── /compare handler ───────────────────────────────────────────────────────

export async function handleCompare(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const query = (ctx.message?.text ?? "").split(" ").slice(1).join(" ").trim();
  if (!query) {
    await ctx.reply(
      "📊 Usage: <code>/compare &lt;topic&gt;</code>\n\nExample: <code>/compare AI regulation</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  const loading = await ctx.reply(`🔍 Searching for <b>${escapeHtml(query)}</b> across all platforms…`, {
    parse_mode: "HTML",
  });

  try {
    const markets = await searchAllMarkets(query, 12);

    if (markets.length < 2) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ Need at least 2 markets to compare. Try a broader query.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    await saveCompareSession(ctx.from.id, { results: markets, selections: [] });

    await ctx.api.editMessageText(
      ctx.chat!.id,
      loading.message_id,
      `📊 <b>Compare Markets</b>\n\nSelect 2–${MAX_SELECTIONS} markets to compare, then tap the button below:`,
      {
        parse_mode: "HTML",
        reply_markup: selectionKeyboard(markets, []),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Search failed";
    await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, `❌ ${escapeHtml(msg)}`, {
      parse_mode: "HTML",
    });
  }
}

// ── cmp:sel:{idx} — toggle selection ──────────────────────────────────────

export async function handleCompareSelect(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery) return;

  const data = ctx.callbackQuery.data ?? "";
  const idx = parseInt(data.split(":")[2] ?? "0", 10);

  const session = await getCompareSession(ctx.from.id);
  if (!session) {
    await ctx.answerCallbackQuery("Session expired — run /compare again.").catch(() => null);
    return;
  }

  let { selections } = session;

  if (selections.includes(idx)) {
    // Deselect
    selections = selections.filter((s) => s !== idx);
  } else if (selections.length < MAX_SELECTIONS) {
    // Select
    selections = [...selections, idx];
  } else {
    await ctx.answerCallbackQuery(`Max ${MAX_SELECTIONS} markets. Deselect one first.`).catch(() => null);
    return;
  }

  await saveCompareSession(ctx.from.id, { ...session, selections });

  const label = selections.includes(idx) ? "✅ Selected" : "Deselected";
  await ctx.answerCallbackQuery(label).catch(() => null);

  await ctx.editMessageReplyMarkup({
    reply_markup: selectionKeyboard(session.results, selections),
  }).catch(() => null);
}

// ── cmp:go — run comparison on selected markets ────────────────────────────

export async function handleCompareConfirm(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery) return;

  const session = await getCompareSession(ctx.from.id);
  if (!session || session.selections.length < 2) {
    await ctx.answerCallbackQuery("Select at least 2 markets first.").catch(() => null);
    return;
  }

  await ctx.answerCallbackQuery("Comparing…").catch(() => null);

  const selected = session.selections.map((i) => session.results[i]).filter(Boolean);

  // Quick summary header while AI generates
  const header = selected
    .map((m, i) => {
      const src = m.source === "polymarket" ? "PM" : "BY";
      return `${i + 1}. [${src}] ${truncate(m.question, 45)} — ${formatProbability(m.probability)} | ${formatVolume(m.volume)}`;
    })
    .join("\n");

  await ctx.editMessageText(
    `📊 <b>Comparing ${selected.length} markets…</b>\n\n<pre>${escapeHtml(header)}</pre>\n\n⏳ <i>AI analysis in progress…</i>`,
    { parse_mode: "HTML" }
  ).catch(() => null);

  try {
    const comparison = await aiCompare(selected);
    const body =
      `📊 <b>Market Comparison</b>\n\n` +
      `<b>Markets:</b>\n<pre>${escapeHtml(header)}</pre>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 <b>AI Analysis</b>\n\n` +
      `${escapeHtml(comparison)}`;

    const kb = new InlineKeyboard().text("🔄 Re-run Comparison", "cmp:go");
    await ctx.editMessageText(body, {
      parse_mode: "HTML",
      reply_markup: kb,
    }).catch(() => null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Comparison failed";
    await ctx.editMessageText(`❌ ${escapeHtml(msg)}`, { parse_mode: "HTML" }).catch(() => null);
  }
}
