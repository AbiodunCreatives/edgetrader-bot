import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { searchAllMarkets } from "../../services/markets/aggregator.js";
import {
  createGameSession,
  getActiveGameSessions,
  resolveGameSession,
  castVote,
  getSessionVotes,
  getUserByTelegramId,
  getLeaderboard,
  refreshLeaderboard,
} from "../../db/queries.js";
import { saveGameSessionMeta, getGameSessionMeta } from "../session.js";
import { escapeHtml, bold, probBar, formatProbability } from "../../utils/format.js";
import { redis } from "../../utils/rateLimit.js";
import type { MarketData } from "../../services/markets/types.js";

const CONFIDENCE_LEVELS = [
  { label: "🤔 Low (30%)", value: 30 },
  { label: "😐 Medium (60%)", value: 60 },
  { label: "💪 High (90%)", value: 90 },
];

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** First 8 chars of a UUID — short enough for callback data */
function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

function voteKeyboard(sessionId: string): InlineKeyboard {
  const sid = shortId(sessionId);
  const kb = new InlineKeyboard();
  CONFIDENCE_LEVELS.forEach((c) => {
    kb.text(`✅ YES — ${c.label}`, `gv:y:${sid}:${c.value}`)
      .text(`❌ NO — ${c.label}`, `gv:n:${sid}:${c.value}`)
      .row();
  });
  return kb;
}

function buildGameMessage(
  market: MarketData,
  sessionId: string,
  yesCnt: number,
  noCnt: number,
  totalVotes: number
): string {
  const yesBar = probBar(totalVotes > 0 ? yesCnt / totalVotes : 0.5, 12);
  const noBar = probBar(totalVotes > 0 ? noCnt / totalVotes : 0.5, 12);

  return (
    `🎮 <b>Prediction Game</b>\n\n` +
    `${bold(escapeHtml(truncate(market.question, 80)))}\n\n` +
    `🏛 Market probability: <b>${formatProbability(market.probability)}</b>\n\n` +
    `📊 <b>Current votes (${totalVotes}):</b>\n` +
    `✅ YES ${yesBar} ${yesCnt}\n` +
    `❌ NO  ${noBar} ${noCnt}\n\n` +
    `⏰ <i>Vote closes in 24 hours. Choose your prediction + confidence:</i>\n` +
    `🔗 <a href="${market.url}">View market</a>`
  );
}

// ── /game handler ──────────────────────────────────────────────────────────

export async function handleGame(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const isGroup = ctx.chat?.type !== "private";
  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  // ── /game leaderboard ────────────────────────────────────────────────────
  if (subcommand === "leaderboard") {
    if (!isGroup) {
      await ctx.reply("🏆 Leaderboards are per group chat. Add me to a group and start a game!", { parse_mode: "HTML" });
      return;
    }
    await showLeaderboard(ctx);
    return;
  }

  // ── /game resolve <yes|no> ───────────────────────────────────────────────
  if (subcommand === "resolve") {
    if (!isGroup) {
      await ctx.reply("Games can only be resolved in group chats.", { parse_mode: "HTML" });
      return;
    }
    const outcome = args[1]?.toLowerCase();
    if (outcome !== "yes" && outcome !== "no") {
      await ctx.reply("Usage: <code>/game resolve yes</code> or <code>/game resolve no</code>", {
        parse_mode: "HTML",
      });
      return;
    }
    await resolveActiveGame(ctx, outcome);
    return;
  }

  // ── /game <query> — start a new game ────────────────────────────────────
  if (!isGroup) {
    await ctx.reply(
      "🎮 <b>Prediction Games</b> are for group chats!\n\nAdd me to a group and use <code>/game &lt;topic&gt;</code> to start.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const query = args.join(" ").trim();
  if (!query) {
    await ctx.reply(
      "🎮 Usage: <code>/game &lt;topic&gt;</code>\n\nExample: <code>/game Bitcoin halving</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => null);
  const loading = await ctx.reply(`🔍 Finding a market for <b>${escapeHtml(query)}</b>…`, {
    parse_mode: "HTML",
  });

  try {
    const markets = await searchAllMarkets(query, 5);
    if (markets.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loading.message_id,
        `❌ No markets found for "<b>${escapeHtml(query)}</b>". Try a different topic.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const market = markets[0]!; // Use the top result by volume
    const session = await createGameSession({
      chat_id: ctx.chat!.id,
      market_id: `${market.source}:${market.id}`,
      market_question: market.question,
    });
    void redis.incr("stats:games_started").catch(() => null);

    const kb = voteKeyboard(session.id);
    const body = buildGameMessage(market, session.id, 0, 0, 0);

    await ctx.api.deleteMessage(ctx.chat!.id, loading.message_id).catch(() => null);

    const gameMsg = await ctx.reply(body, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: kb,
    });

    // Store meta so vote callbacks can edit this message
    await saveGameSessionMeta(shortId(session.id), {
      fullId: session.id,
      chatId: ctx.chat!.id,
      messageId: gameMsg.message_id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to start game";
    await ctx.api
      .editMessageText(ctx.chat!.id, loading.message_id, `❌ ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      })
      .catch(() => null);
  }
}

// ── gv:{y|n}:{shortId}:{confidence} — user casts a vote ──────────────────

export async function handleGameVote(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery) return;

  const data = ctx.callbackQuery.data ?? ""; // "gv:y:ab12cd34:60"
  const parts = data.split(":");
  const yn = parts[1];          // "y" | "n"
  const sid = parts[2]!;        // 8-char short session ID
  const confidence = parseInt(parts[3] ?? "50", 10);

  const meta = await getGameSessionMeta(sid);
  if (!meta) {
    await ctx.answerCallbackQuery("Game session not found or expired.").catch(() => null);
    return;
  }

  const user = await getUserByTelegramId(ctx.from.id);
  if (!user) {
    await ctx.answerCallbackQuery("Please send /start to register first.").catch(() => null);
    return;
  }

  const prediction = yn === "y" ? "yes" : "no";

  try {
    await castVote({
      session_id: meta.fullId,
      user_id: user.id,
      prediction,
      confidence,
    });

    const label = prediction === "yes" ? "✅ YES" : "❌ NO";
    await ctx.answerCallbackQuery(`Voted ${label} (${confidence}% confidence)!`).catch(() => null);

    // Recount and update the game message
    await refreshGameMessage(ctx, meta, sid);
  } catch (err) {
    await ctx.answerCallbackQuery("Failed to record vote. Try again.").catch(() => null);
    console.error("[game] castVote error:", err);
  }
}

/** Fetch current vote counts and edit the game message in-place. */
async function refreshGameMessage(
  ctx: Context,
  meta: { fullId: string; chatId: number; messageId: number },
  sid: string
): Promise<void> {
  try {
    const votes = await getSessionVotes(meta.fullId);
    const yesCnt = votes.filter((v) => v.prediction === "yes").length;
    const noCnt = votes.filter((v) => v.prediction === "no").length;
    const total = votes.length;

    // We need the market data to rebuild the message. Fetch from active sessions.
    const sessions = await getActiveGameSessions(meta.chatId);
    const session = sessions.find((s) => s.id === meta.fullId);
    if (!session) return;

    // Reconstruct minimal MarketData for display
    const [source, ...idParts] = (session.market_id ?? "").split(":");
    const fakeMarket: MarketData = {
      id: idParts.join(":"),
      source: ((source ?? "polymarket") === "bayse" ? "bayse" : "polymarket"),
      question: session.market_question ?? "Unknown market",
      probability: 0.5,
      lastPrice: 0.5,
      volume: 0,
      endDate: null,
      url: "#",
      category: null,
    };

    const body = buildGameMessage(fakeMarket, meta.fullId, yesCnt, noCnt, total);

    await ctx.api.editMessageText(meta.chatId, meta.messageId, body, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: voteKeyboard(meta.fullId),
    });
  } catch {
    // Non-fatal — vote was recorded, message update just failed
  }
}

// ── /game resolve <yes|no> ────────────────────────────────────────────────

async function resolveActiveGame(ctx: Context, outcome: "yes" | "no"): Promise<void> {
  const sessions = await getActiveGameSessions(ctx.chat!.id);
  if (sessions.length === 0) {
    await ctx.reply("No active game sessions in this chat. Start one with <code>/game &lt;topic&gt;</code>.", { parse_mode: "HTML" });
    return;
  }

  const session = sessions[0]!; // resolve the most recent one
  await resolveGameSession(session.id, outcome);

  const votes = await getSessionVotes(session.id);
  const total = votes.length;
  const correct = votes.filter((v) => v.prediction === outcome).length;
  const accuracy = total > 0 ? ((correct / total) * 100).toFixed(0) : "0";

  await refreshLeaderboard().catch(() => null);

  await ctx.reply(
    `🏁 <b>Game Resolved!</b>\n\n` +
      `📌 ${bold(escapeHtml(truncate(session.market_question ?? "Market", 70)))}\n\n` +
      `✅ Correct answer: <b>${outcome.toUpperCase()}</b>\n\n` +
      `📊 <b>Results:</b>\n` +
      `${total} vote${total !== 1 ? "s" : ""} — ${correct} correct (${accuracy}%)\n\n` +
      `🏆 See updated rankings: <code>/game leaderboard</code>`,
    { parse_mode: "HTML" }
  );
}

// ── /game leaderboard ─────────────────────────────────────────────────────

async function showLeaderboard(ctx: Context): Promise<void> {
  const entries = await getLeaderboard(ctx.chat!.id, 10);

  if (entries.length === 0) {
    await ctx.reply(
      "🏆 No scores yet! Start a game with <code>/game &lt;topic&gt;</code> and get people voting.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const rows = entries.map((e) => {
    const medal = medals[e.rank - 1] ?? `#${e.rank}`;
    const name = escapeHtml(e.username ? `@${e.username}` : `User${e.telegram_id}`);
    const streak = e.current_streak > 1 ? ` 🔥${e.current_streak}` : "";
    return `${medal} ${name} — ${e.correct_count}/${e.total_votes} (${e.accuracy_pct}%)${streak}`;
  });

  await ctx.reply(
    `🏆 <b>Leaderboard</b>\n\n${rows.join("\n")}\n\n` +
      `Brier score shown in brackets — lower is better.\n` +
      `Start a new game: <code>/game &lt;topic&gt;</code>`,
    { parse_mode: "HTML" }
  );
}
