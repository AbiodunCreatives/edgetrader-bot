# Edge Trader Bot

AI copilot for prediction markets inside Telegram. Searches Polymarket + Bayse, uses Claude for analysis, and runs alerts/games with Supabase + Redis backing. Static landing page lives in `landing/`.

## Quick start
1) Install deps: `pnpm install`
2) Copy env: `copy .env.example .env` (or `cp ...`) and fill required keys (`BOT_TOKEN`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`; set `WEBHOOK_URL` for production)
3) Dev: `pnpm dev` (long polling, serves `GET /health` on `PORT`, default 3000)
4) Prod webhook: set `WEBHOOK_URL`, then `pnpm start` (registers `/webhook/{BOT_TOKEN}`)

## Commands (Telegram)
`/start`, `/help`, `/search <topic>`, `/compare <topic>`, `/picks`, `/alert`, `/portfolio`, `/game`, `/stats`, `/upgrade` (+ inline queries)

## Deploy
- `./deploy.sh railway` or `./deploy.sh fly` (CLI + .env required)
- Docker: `docker build -t edge-trader-bot .` then `docker run --env-file .env -p 3000:3000 edge-trader-bot`

## Tech
TypeScript, grammY, Express, Supabase Postgres (`src/db/schema.sql`), Redis, Anthropic/Claude, Polymarket Gamma API, Bayse API.

## License
MIT
