# Edge Trader Bot

AI copilot for prediction markets that runs inside Telegram. The bot searches Polymarket and Bayse, uses Claude for analysis, caches markets in Supabase, and schedules Redis-backed alerts. A static marketing page lives in `landing/` for demos.

## Features
- Search and compare Polymarket + Bayse markets with AI freshness checks.
- Price/volume alerts, inline mode, and daily picks.
- Group games with voting, scoring, and leaderboards.
- Portfolio tracking and live platform stats.
- Health endpoint and cron-based alert scheduler.

## Stack
- TypeScript + Node 20 (pnpm).
- grammY for Telegram, Express for webhook/health.
- Claude via Anthropic API.
- Supabase Postgres (schema in `src/db/schema.sql`).
- Redis for rate limiting, caching, and alerts.
- Polymarket Gamma API + Bayse public API.
- Dockerfile and `deploy.sh` for Fly.io or Railway.

## Prerequisites
- Node 20+ and pnpm (`corepack enable` recommended).
- Telegram bot token from @BotFather.
- Anthropic API key.
- Supabase project with service-role key.
- Redis instance (Upstash or self-hosted).
- Public HTTPS URL for webhook mode (production).

## Setup
1) Install deps
```
pnpm install
```
2) Copy env template
```
copy .env.example .env   # Windows
# or: cp .env.example .env
```
3) Fill `.env` values (key vars)
   - `BOT_TOKEN`, `WEBHOOK_URL` (set for production), `WEBHOOK_SECRET`, `PORT`
   - `ANTHROPIC_API_KEY`, `ANTHROPIC_DAILY_TOKEN_BUDGET`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `REDIS_URL`
   - Optional: `POLYMARKET_API_URL`, `POLYMARKET_CLOB_URL`, rate-limit/cache knobs.
4) Seed the database: run `src/db/schema.sql` in the Supabase SQL editor (or `psql`).
5) Development (long polling): leave `WEBHOOK_URL` empty and run:
```
pnpm dev
```
   Bot starts polling and exposes `GET /health` on `PORT` (default 3000).
6) Production (webhook): set `WEBHOOK_URL` to your public base URL, then:
```
pnpm start
```
   The bot registers a webhook at `/webhook/{BOT_TOKEN}` and serves `/health`.

## Deployment
- One-step scripts: `./deploy.sh railway` or `./deploy.sh fly` (requires the respective CLI logged in and `.env` filled). `./deploy.sh webhook` re-registers the Telegram webhook without redeploying.
- Docker: `docker build -t edge-trader-bot .` then `docker run --env-file .env -p 3000:3000 edge-trader-bot`.

## Bot commands
- `/start` main menu and navigation.
- `/help` quick command reference.
- `/search <topic>` search markets with AI analysis (inline mode supported).
- `/compare <topic>` find similar markets across sources.
- `/picks` daily top opportunities.
- `/alert` view/create price or volume alerts.
- `/portfolio` track positions.
- `/game` group prediction games and leaderboards.
- `/stats` live platform counters.
- `/upgrade` plan info.
- Inline queries and reset handlers live in `src/bot/commands.ts`.

## Monitoring
- Health: `GET /health` returns uptime plus cache/alert counts.
- Scheduler: alert checks run via `node-cron`; in dev the Redis DB is flushed on startup (see `src/index.ts`), so use a separate Redis instance for local work.

## Landing page
- Static marketing page at `landing/index.html` for quick hosting or embedding.

## Useful scripts
- `pnpm dev` - watch mode (long polling).
- `pnpm start` - run once (uses webhook if `WEBHOOK_URL` is set).
- `pnpm typecheck` - TypeScript type checks.
- `pnpm build` - emit compiled JS to `dist/`.

## License
ISC
