/**
 * Edge Trader Bot — entry point.
 *
 * Start-up sequence:
 *   1. config.ts validates all env vars (exits on missing required vars)
 *   2. Grammy Bot instance + commands registered
 *   3. Express server created with /health + /webhook routes
 *   4. Scheduler cron jobs started
 *   5a. WEBHOOK_URL set   → register webhook with Telegram, start Express
 *   5b. WEBHOOK_URL unset → long-polling (development)
 *
 * Graceful shutdown (SIGTERM / SIGINT):
 *   - Stop cron tasks → close HTTP server → quit Redis → stop polling (if any)
 */

import { Bot } from "grammy";
import express from "express";
import { createServer } from "http";
import nodeCron from "node-cron";

import { config } from "./config.js";
import { redis } from "./utils/rateLimit.js";
import { supabase } from "./db/client.js";
import { registerCommands } from "./bot/commands.js";
import { startScheduler } from "./services/alerts/scheduler.js";
import { getTrendingBayseMarkets } from "./services/markets/bayse.js";

// ── Bot ───────────────────────────────────────────────────────────────────────

const bot = new Bot(config.BOT_TOKEN);
registerCommands(bot);

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
// Limit payload size to mitigate abuse on the webhook endpoint
app.use(express.json({ limit: "100kb" }));

// GET /health ─────────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const [marketsResult, alertsResult, redisResult] = await Promise.allSettled([
    supabase
      .from("markets_cache")
      .select("*", { count: "exact", head: true }),
    supabase
      .from("alerts")
      .select("*", { count: "exact", head: true })
      .eq("triggered", false),
    redis.dbsize(),
  ]);

  const marketsCached =
    marketsResult.status === "fulfilled"
      ? (marketsResult.value.count ?? 0)
      : null;

  const activeAlerts =
    alertsResult.status === "fulfilled"
      ? (alertsResult.value.count ?? 0)
      : null;

  const redisKeys =
    redisResult.status === "fulfilled" ? redisResult.value : null;

  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    markets_cached: marketsCached,
    active_alerts: activeAlerts,
    redis_keys: redisKeys,
  });
});

// POST /webhook/:token ─────────────────────────────────────────────────────────

app.post("/webhook/:secret", (req, res) => {
  // Reject requests with the wrong path secret before touching the update
  if (req.params["secret"] !== config.WEBHOOK_PATH_SECRET) {
    console.warn("[webhook] Rejected request with invalid path secret");
    res.sendStatus(403);
    return;
  }

  // Optional: Telegram header-based secret (strongly recommended in prod)
  const headerSecret = req.header("x-telegram-bot-api-secret-token");
  if (config.WEBHOOK_SECRET && headerSecret !== config.WEBHOOK_SECRET) {
    console.warn("[webhook] Rejected request with invalid secret token header");
    res.sendStatus(403);
    return;
  }

  // Acknowledge immediately — Telegram retries if it doesn't get 200 within ~15s.
  // Long-running handlers (Claude AI, market fetches) would trigger retries and
  // cause duplicate responses if we awaited handleUpdate before responding.
  res.sendStatus(200);

  bot.handleUpdate(req.body).catch((err) => {
    console.error("[webhook] Unhandled error in handleUpdate:", err);
  });
});

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer(app);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] Port ${config.PORT} is already in use. Kill the other process or set a different PORT in .env.`);
    process.exit(1);
  }
  throw err;
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[server] ${signal} received — shutting down gracefully…`);

  // 1. Stop cron tasks (prevent new executions mid-shutdown)
  const tasks = nodeCron.getTasks();
  for (const [name, task] of tasks) {
    await task.stop();
    console.log(`[scheduler] Stopped: ${name}`);
  }

  // 2. Close HTTP server (finish in-flight requests, reject new ones)
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  console.log("[server] HTTP server closed.");

  // 3. Quit Redis
  try {
    await redis.quit();
    console.log("[redis] Connection closed.");
  } catch {
    redis.disconnect(); // Force-disconnect if quit times out
  }

  // 4. Stop long-polling (no-op in webhook mode but safe to call)
  bot.stop();

  console.log("[server] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));

// ── Start-up ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[server] Starting Edge Trader Bot…");

  // ── Redis startup check ──────────────────────────────────────────────────
  // lazyConnect=true means the connection only opens on the first command.
  // Connect explicitly here so any misconfiguration is caught immediately
  // rather than silently hanging on the first user request.
  try {
    await redis.ping();
    console.log("[redis] Startup ping OK.");

    // In development, flush stale rate-limit counters so debugging sessions
    // don't carry over quota exhausted from previous runs.
    // WARNING: this clears ALL keys in the Redis DB — use a dedicated dev instance.
    if (config.NODE_ENV === "development") {
      await redis.flushdb();
      console.log("[redis] Dev mode: FLUSHDB — all keys cleared.");
    }
  } catch (err) {
    console.error("[redis] Startup check FAILED — rate limiting and session storage will not work:", err);
    // Non-fatal: bot can still serve some commands, but warn loudly
  }

  // Warm Bayse market cache in the background so first search is instant
  getTrendingBayseMarkets().then((m) =>
    console.log(`[bayse] Cache warmed — ${m.length} markets loaded.`)
  ).catch((err) =>
    console.warn("[bayse] Cache warm failed:", (err as Error).message)
  );

  // Start background cron jobs (both modes need them)
  startScheduler();

  // grammY requires bot.init() in webhook mode (bot.start() handles it in polling mode)
  await bot.init();
  console.log(`[bot] Initialized as @${bot.botInfo.username}`);

  if (config.WEBHOOK_URL) {
    // ── Webhook mode (production) ────────────────────────────────────────────
    const webhookUrl = `${config.WEBHOOK_URL}/webhook/${config.WEBHOOK_PATH_SECRET}`;

    await bot.api.setWebhook(webhookUrl, {
      ...(config.WEBHOOK_SECRET ? { secret_token: config.WEBHOOK_SECRET } : {}),
      // Only receive the update types we actually handle
      allowed_updates: [
        "message",
        "callback_query",
        "inline_query",
        "my_chat_member",
      ],
      drop_pending_updates: true,
    });

    console.log(`[bot] Webhook registered → ${webhookUrl}`);

    server.listen(config.PORT, () => {
      console.log(
        `[server] Listening on port ${config.PORT}\n` +
          `[server] Ready:\n` +
          `  • POST /webhook/:token\n` +
          `  • GET  /health`
      );
    });
  } else {
    // ── Long-polling mode (development) ─────────────────────────────────────
    console.log("[bot] WEBHOOK_URL not set — using long polling (dev mode).");

    // Remove any stale webhook so polling works (non-fatal if offline)
    await bot.api.deleteWebhook().catch((err) =>
      console.warn("[bot] deleteWebhook failed (network?):", (err as Error).message)
    );

    // Start a minimal Express server for /health even in polling mode
    server.listen(config.PORT, () => {
      console.log(`[server] Health endpoint on port ${config.PORT} → GET /health`);
    });

    // bot.start() blocks until bot.stop() is called
    bot.start({
      onStart: (info) => {
        console.log(`[bot] Long polling started (@${info.username}).`);
      },
    });
  }
}

main().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
