import type { Context } from "grammy";
import { supabase } from "../../db/client.js";
import {
  getPortfolio,
  addPortfolioEntry,
  deletePortfolioEntry,
  getUserByTelegramId,
} from "../../db/queries.js";
import { escapeHtml, formatProbability } from "../../utils/format.js";
import type { DbPortfolioEntry } from "../../db/queries.js";

function pad(s: string, n: number): string {
  return s.slice(0, n).padEnd(n);
}

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return "–";
  return n.toFixed(decimals);
}

/** Format all positions as a monospace table. */
async function buildPortfolioTable(entries: DbPortfolioEntry[]): Promise<string> {
  if (entries.length === 0) return "No positions yet.";

  // Batch-fetch current prices from markets_cache
  const platformIds = entries.map((e) => e.market_id.split(":")[1]).filter(Boolean);
  const { data: cached } = await supabase
    .from("markets_cache")
    .select("id, probability")
    .in("id", platformIds);

  const priceMap = new Map<string, number>(
    (cached ?? []).map((row) => [row.id as string, row.probability as number])
  );

  const header = `${"#".padEnd(3)} ${"Side".padEnd(4)} ${"Entry".padEnd(7)} ${"Now".padEnd(7)} ${"Qty".padEnd(8)} ${"P&L"}`;
  const divider = "─".repeat(header.length);

  const rows = entries.map((e, i) => {
    const platformId = e.market_id.split(":")[1] ?? "";
    const current = priceMap.get(platformId) ?? null;
    const entry = e.entry_price;
    const qty = e.quantity;

    let pnl = "–";
    if (current != null && entry != null && qty != null) {
      const side = e.position === "yes" ? 1 : -1;
      const pnlRaw = side * (current - entry) * qty;
      const sign = pnlRaw >= 0 ? "+" : "";
      pnl = `${sign}$${pnlRaw.toFixed(2)}`;
    }

    const side = (e.position ?? "–").toUpperCase();
    const entryStr = entry != null ? `${(entry * 100).toFixed(1)}¢` : "–";
    const nowStr = current != null ? `${(current * 100).toFixed(1)}¢` : "–";
    const qtyStr = qty != null ? qty.toString() : "–";

    return `${String(i + 1).padEnd(3)} ${pad(side, 4)} ${pad(entryStr, 7)} ${pad(nowStr, 7)} ${pad(qtyStr, 8)} ${pnl}`;
  });

  return [header, divider, ...rows].join("\n");
}

// ── /portfolio ─────────────────────────────────────────────────────────────

export async function handlePortfolio(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const text = (ctx.message?.text ?? "").trim();
  const args = text.split(/\s+/).slice(1); // drop "/portfolio"
  const subcommand = args[0]?.toLowerCase();

  const user = await getUserByTelegramId(ctx.from.id);
  if (!user) { await ctx.reply("Send /start first to register.", { parse_mode: "HTML" }); return; }

  // ── /portfolio (no args) or /portfolio list ──────────────────────────────
  if (!subcommand || subcommand === "list") {
    const entries = await getPortfolio(user.id);

    if (entries.length === 0) {
      await ctx.reply(
        `💼 <b>My Portfolio</b>\n\nNo positions yet.\n\n` +
          `Add one:\n<code>/portfolio add &lt;market_id&gt; yes|no &lt;price&gt; &lt;qty&gt;</code>\n\n` +
          `Example:\n<code>/portfolio add polymarket:0xabc... yes 0.65 100</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const table = await buildPortfolioTable(entries);
    const entryList = entries
      .map((e, i) => {
        const src = e.market_id.split(":")[0];
        const id = e.market_id.split(":")[1]?.slice(0, 10) ?? "?";
        return `${i + 1}. [${src}] <code>${id}…</code> — ${e.position?.toUpperCase() ?? "–"} — ID: <code>${e.id.slice(0, 8)}</code>`;
      })
      .join("\n");

    await ctx.reply(
      `💼 <b>My Portfolio</b> (${entries.length} position${entries.length !== 1 ? "s" : ""})\n\n` +
        `<pre>${escapeHtml(table)}</pre>\n\n` +
        `<b>Positions:</b>\n${entryList}\n\n` +
        `Remove: <code>/portfolio remove &lt;id&gt;</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // ── /portfolio add <market_id> <yes|no> <price> <quantity> ──────────────
  if (subcommand === "add") {
    const marketId = args[1];
    const positionArg = args[2]?.toLowerCase();
    const priceArg = parseFloat(args[3] ?? "");
    const qtyArg = parseFloat(args[4] ?? "");

    if (
      !marketId ||
      !["yes", "no"].includes(positionArg ?? "") ||
      isNaN(priceArg) ||
      isNaN(qtyArg) ||
      priceArg < 0 ||
      priceArg > 1 ||
      qtyArg <= 0
    ) {
      await ctx.reply(
        `💼 <b>Add Position</b>\n\n` +
          `Usage: <code>/portfolio add &lt;market_id&gt; yes|no &lt;price 0-1&gt; &lt;quantity&gt;</code>\n\n` +
          `<b>price</b> = entry probability (e.g. <code>0.65</code> = 65¢)\n` +
          `<b>quantity</b> = number of shares\n\n` +
          `Example:\n<code>/portfolio add polymarket:0xabc yes 0.65 100</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const position = positionArg as "yes" | "no";
    const entry = await addPortfolioEntry({
      user_id: user.id,
      market_id: marketId,
      position,
      entry_price: priceArg,
      quantity: qtyArg,
    });

    await ctx.reply(
      `✅ <b>Position added!</b>\n\n` +
        `📌 Market: <code>${escapeHtml(marketId)}</code>\n` +
        `Side: <b>${position.toUpperCase()}</b>\n` +
        `Entry: <b>${(priceArg * 100).toFixed(1)}¢</b>\n` +
        `Quantity: <b>${qtyArg}</b> shares\n\n` +
        `Entry ID: <code>${entry.id.slice(0, 8)}</code>\n` +
        `View: /portfolio`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // ── /portfolio remove <id> ───────────────────────────────────────────────
  if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
    const entryId = args[1];
    if (!entryId) {
      await ctx.reply(
        "Usage: <code>/portfolio remove &lt;entry_id&gt;</code>\n\nGet IDs from /portfolio",
        { parse_mode: "HTML" }
      );
      return;
    }

    // Accept both full UUID and 8-char prefix
    const entries = await getPortfolio(user.id);
    const match = entries.find((e) => e.id === entryId || e.id.startsWith(entryId));
    if (!match) {
      await ctx.reply(`❌ Position <code>${escapeHtml(entryId)}</code> not found.`, { parse_mode: "HTML" });
      return;
    }

    await deletePortfolioEntry(user.id, match.id);
    await ctx.reply(`✅ Position removed.\n\nView: /portfolio`, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(
    "Unknown sub-command.\n\nUse:\n• <code>/portfolio</code>\n• <code>/portfolio add …</code>\n• <code>/portfolio remove &lt;id&gt;</code>",
    { parse_mode: "HTML" }
  );
}
