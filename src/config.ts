import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  // Telegram
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  WEBHOOK_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional()
  ),
  WEBHOOK_PATH_SECRET: z.preprocess(
    (v) => (v === "" || v === undefined ? "dev-webhook-secret" : v),
    z.string().min(12, "WEBHOOK_PATH_SECRET must be at least 12 characters")
  ),
  WEBHOOK_SECRET: z.string().optional(),
  PORT: z.coerce.number().default(3000),

  // Anthropic / Claude
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  // Supabase
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),

  // Redis (Upstash or self-hosted)
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // Optional: Polymarket
  POLYMARKET_API_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_URL: z.string().url().default("https://clob.polymarket.com"),

  // Rate limiting
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(10),

  // Cache TTL
  CACHE_TTL_SECONDS: z.coerce.number().default(300),

  // AI token budget (total input+output tokens allowed per 24-hour window)
  ANTHROPIC_DAILY_TOKEN_BUDGET: z.coerce.number().default(100_000),

  // Admin
  ADMIN_TELEGRAM_ID: z.coerce.number().optional(),

  // Health endpoint protection
  HEALTH_CHECK_TOKEN: z.string().optional(),

  // Environment
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("ERROR: Invalid environment variables:");
  for (const [field, errors] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${errors?.join(", ")}`);
  }
  process.exit(1);
}

const config = parsed.data;

// Hard guards for production deployments
if (config.NODE_ENV === "production") {
  if (!config.WEBHOOK_SECRET) {
    console.error("ERROR: WEBHOOK_SECRET is required in production (prevents forged webhook calls).");
    process.exit(1);
  }
  if (config.WEBHOOK_PATH_SECRET === "dev-webhook-secret") {
    console.error("ERROR: Set WEBHOOK_PATH_SECRET to a unique value in production.");
    process.exit(1);
  }
  if (!config.HEALTH_CHECK_TOKEN) {
    console.error("ERROR: HEALTH_CHECK_TOKEN is required in production to protect /health.");
    process.exit(1);
  }
}

export { config };
export type Config = typeof config;
