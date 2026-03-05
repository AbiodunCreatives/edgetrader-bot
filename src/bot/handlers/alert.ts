import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  createAlert,
  getUserAlerts,
  deleteAlert,
  getUserByTelegramId,
} from "../../db/queries.js";
import { getAlertState, saveAlertState, clearAlertState } from "../session.js";
import { escapeHtml, bold, formatProbability } from "../../utils/format.js";
import { checkAlertQuota, buildAlertQuotaCta } from "../../utils/rateLimit.js";
import type { DbAlert } from "../../db/queries.js";
import { redis } from "../../utils/rateLimit.js";

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

const THRESHOLD_PRESETS = [10, 25, 50, 75, 90];

function thresholdKeyboard(condition: "above" | "below"): InlineKeyboard {
  const kb = new InlineKeyboard();
  THRESHOLD_PRESETS.forEach((pct, i) => {
    kb.text(`${pct}%`, `alt:${condition}:${pct}`);
    if (i === 2) kb.row(); // line break after 3rd button
  });
  return kb;
}

function formatAlert(alert: DbAlert, index: number): string {
  const cond = alert.condition === "above" ? "📈 above" : alert.condition === "below" ? "📉 below" : "📊 volume spike";
  const pct = alert.condition === "volume_spike" ? `$${alert.threshold}` : formatProbability(alert.threshold / 100);
  return `${index + 1}. ${cond} ${pct} — <code>${escapeHtml(alert.market_id)}</code>`;
}

// ── /alert ─────────────────────────────────────────────────────────────────

export async function handleAlert(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const text = (ctx.message?.text ?? "").trim();
  const args = text.split(/\s+/).slice(1); // drop "/alert"

  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "list") {
    await showAlerts(ctx);
    return;
  }

  if (subcommand === "set") {
    // /alert set <market_id> above|below <threshold>
    const marketId = args[1];
    const condition = args[2] as "above" | "below";
    const thresholdArg = parseFloat(args[3] ?? "");

    if (!marketId || !["above", "below"].includes(condition) || isNaN(thresholdArg)) {
      await ctx.reply(
        `⚡ <b>Set Alert</b>\n\nUsage: <code>/alert set &lt;market_id&gt; above|below &lt;threshold%&gt;</code>\n\n` +
          `Example: <code>/alert set polymarket:0xabc... above 65</code>\n\n` +
          `Or find a market with /search and tap the <b>Set Alert</b> button.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const user = await getUserByTelegramId(ctx.from.id);
    if (!user) { await ctx.reply("❌ User not found. Send /start first.", { parse_mode: "HTML" }); return; }

    const quota = await checkAlertQuota(ctx.from.id);
    if (!quota.allowed) {
      await ctx.reply(buildAlertQuotaCta(quota.current, quota.max!), { parse_mode: "HTML" });
      return;
    }

    const threshold = Math.min(100, Math.max(0, thresholdArg));
    const alert = await createAlert({
      user_id: user.id,
      market_id: marketId,
      condition,
      threshold,
    });

    const arrow = condition === "above" ? "📈" : "📉";
    await ctx.reply(
      `✅ Alert set!\n\n` +
        `${arrow} Notify me when <code>${escapeHtml(marketId)}</code> goes <b>${condition} ${threshold}%</b>\n\n` +
        `Alert ID: <code>${alert.id}</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (subcommand === "delete" || subcommand === "del") {
    const alertId = args[1];
    if (!alertId) {
      await ctx.reply("Usage: <code>/alert delete &lt;alert_id&gt;</code>", { parse_mode: "HTML" });
      return;
    }

    const user = await getUserByTelegramId(ctx.from.id);
    if (!user) { await ctx.reply("❌ User not found.", { parse_mode: "HTML" }); return; }

    await deleteAlert(user.id, alertId);
    await ctx.reply(`✅ Alert <code>${escapeHtml(alertId)}</code> deleted.`, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply("Unknown sub-command. Use: <code>/alert</code>, <code>/alert set …</code>, or <code>/alert delete &lt;id&gt;</code>", {
    parse_mode: "HTML",
  });
}

async function showAlerts(ctx: Context): Promise<void> {
  const user = await getUserByTelegramId(ctx.from!.id);
  if (!user) { await ctx.reply("Send /start first.", { parse_mode: "HTML" }); return; }

  const alerts = await getUserAlerts(user.id);

  if (alerts.length === 0) {
    await ctx.reply(
      `⚡ <b>My Alerts</b>\n\nNo active alerts yet.\n\n` +
        `Find a market with /search and tap <b>Set Alert</b> to create one.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const lines = alerts.map((a, i) => formatAlert(a, i)).join("\n");
  const kb = new InlineKeyboard();
  alerts.slice(0, 5).forEach((a) => {
    kb.text(`🗑 Delete #${a.id.slice(0, 6)}`, `ald:${a.id}`).row();
  });

  await ctx.reply(
    `⚡ <b>My Alerts</b> (${alerts.length})\n\n${lines}`,
    { parse_mode: "HTML", reply_markup: kb }
  );
}

// ── als:{condition} — user chose above/below in the flow ──────────────────

export async function handleAlertSetCondition(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery) return;

  const data = ctx.callbackQuery.data ?? "";
  const condition = data.slice(4) as "above" | "below"; // strip "als:"

  const state = await getAlertState(ctx.from.id);
  if (!state) {
    await ctx.answerCallbackQuery("Session expired — find a market and tap Set Alert again.").catch(() => null);
    return;
  }

  await saveAlertState(ctx.from.id, { ...state, condition });
  await ctx.answerCallbackQuery().catch(() => null);

  const arrow = condition === "above" ? "📈" : "📉";
  await ctx.editMessageText(
    `⚡ <b>Set Alert</b>\n\n<i>${escapeHtml(truncate(state.marketQuestion, 60))}</i>\n\n` +
      `${arrow} Notify when probability goes <b>${condition}</b>…\n\nChoose threshold:`,
    { parse_mode: "HTML", reply_markup: thresholdKeyboard(condition) }
  ).catch(() => null);
}

// ── alt:{condition}:{threshold} — threshold chosen ────────────────────────

export async function handleAlertSetThreshold(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery) return;

  const data = ctx.callbackQuery.data ?? ""; // "alt:above:65"
  const parts = data.split(":");
  const condition = parts[1] as "above" | "below";
  const threshold = parseInt(parts[2] ?? "50", 10);

  const state = await getAlertState(ctx.from.id);
  if (!state) {
    await ctx.answerCallbackQuery("Session expired.").catch(() => null);
    return;
  }

  const user = await getUserByTelegramId(ctx.from.id);
  if (!user) { await ctx.answerCallbackQuery("User not found.").catch(() => null); return; }

  const quota = await checkAlertQuota(ctx.from.id);
  if (!quota.allowed) {
    await ctx.answerCallbackQuery("Alert limit reached — see /upgrade").catch(() => null);
    await ctx.reply(buildAlertQuotaCta(quota.current, quota.max!), { parse_mode: "HTML" });
    return;
  }

  try {
    const alert = await createAlert({
      user_id: user.id,
      market_id: state.marketId,
      condition,
      threshold,
    });
    void redis.incr("stats:alerts_created").catch(() => null);

    await clearAlertState(ctx.from.id);
    await ctx.answerCallbackQuery("✅ Alert created!").catch(() => null);

    const arrow = condition === "above" ? "📈" : "📉";
    await ctx.editMessageText(
      `✅ <b>Alert set!</b>\n\n` +
        `${arrow} I'll notify you when:\n` +
        `<i>${escapeHtml(truncate(state.marketQuestion, 70))}</i>\n` +
        `goes <b>${condition} ${threshold}%</b>\n\n` +
        `Alert ID: <code>${alert.id}</code>\n` +
        `Manage alerts: /alert`,
      { parse_mode: "HTML" }
    ).catch(() => null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create alert";
    await ctx.answerCallbackQuery(`❌ ${msg.slice(0, 60)}`).catch(() => null);
  }
}

// ── ald:{alertId} — delete alert button ───────────────────────────────────

export async function handleAlertDelete(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery) return;

  const alertId = (ctx.callbackQuery.data ?? "").slice(4); // strip "ald:"
  const user = await getUserByTelegramId(ctx.from.id);
  if (!user) { await ctx.answerCallbackQuery("User not found.").catch(() => null); return; }

  try {
    await deleteAlert(user.id, alertId);
    await ctx.answerCallbackQuery("✅ Alert deleted").catch(() => null);
    // Refresh the alert list in-place
    await showAlerts(ctx).catch(() => null);
  } catch (err) {
    await ctx.answerCallbackQuery("❌ Could not delete alert.").catch(() => null);
  }
}
