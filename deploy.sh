#!/usr/bin/env bash
# deploy.sh — build, push, configure, and verify Edge Trader Bot
#
# Usage:
#   ./deploy.sh railway          Deploy to Railway (uses `railway` CLI)
#   ./deploy.sh fly              Deploy to Fly.io  (uses `fly` CLI)
#   ./deploy.sh webhook          Re-register Telegram webhook only (no redeploy)
#
# Prerequisites:
#   Railway: npm install -g @railway/cli  &&  railway login  &&  railway link
#   Fly.io:  curl -L https://fly.io/install.sh | sh  &&  fly auth login

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

PLATFORM="${1:-}"
ENV_FILE="${ENV_FILE:-.env}"
FLY_APP="edge-trader-bot"
HEALTH_RETRIES=24   # × 5 s = 120 s timeout
TELEGRAM_API="https://api.telegram.org"

# ── Helpers ───────────────────────────────────────────────────────────────────

log()  { echo "[deploy] $*"; }
err()  { echo "[deploy] ERROR: $*" >&2; exit 1; }
info() { echo ""; echo "  $*"; }

require_cmd() {
  command -v "$1" &>/dev/null || err "'$1' is not installed. $2"
}

# Load .env into the current shell.
# Skips blank lines and lines starting with #.
# Handles quoted values and values with spaces.
load_env() {
  [[ -f "$ENV_FILE" ]] || err ".env not found. Copy .env.example and fill in your values."
  log "Loading $ENV_FILE…"
  # set -a exports every variable assignment; set +a stops it
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
}

# Return true if a variable is set and non-empty
is_set() { [[ -n "${!1:-}" ]]; }

# Require that a variable is set; print a helpful message if not
require_var() {
  local var="$1" hint="${2:-}"
  is_set "$var" || err "$var is not set in $ENV_FILE.${hint:+ $hint}"
}

# Poll GET <url> until it returns {"status":"ok",...} or timeout
wait_for_health() {
  local url="$1"
  local attempt=0
  log "Polling health endpoint: $url"
  while [[ $attempt -lt $HEALTH_RETRIES ]]; do
    local body
    body=$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)
    if echo "$body" | grep -q '"status":"ok"'; then
      log "Health check passed (attempt $((attempt + 1)))."
      return 0
    fi
    attempt=$((attempt + 1))
    if [[ $attempt -lt $HEALTH_RETRIES ]]; then
      log "  …not ready yet (attempt ${attempt}/${HEALTH_RETRIES}), retrying in 5 s"
      sleep 5
    fi
  done
  err "Health check timed out after $((HEALTH_RETRIES * 5)) s. Check platform logs."
}

# Register (or update) the Telegram webhook for the deployed URL
register_webhook() {
  local base_url="$1"         # e.g. https://my-app.up.railway.app
  local webhook_url="${base_url}/webhook/${BOT_TOKEN}"

  log "Registering webhook → ${base_url}/webhook/<token>"

  local response
  response=$(curl -fsSL -X POST \
    "${TELEGRAM_API}/bot${BOT_TOKEN}/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{
      \"url\": \"${webhook_url}\",
      \"drop_pending_updates\": true,
      \"allowed_updates\": [\"message\", \"callback_query\", \"inline_query\", \"my_chat_member\"]
    }")

  if echo "$response" | grep -q '"ok":true'; then
    local desc
    desc=$(echo "$response" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('description',''))" \
      2>/dev/null || true)
    log "Webhook registered. ${desc}"
  else
    err "Webhook registration failed: $response"
  fi
}

# ── Platform: Railway ─────────────────────────────────────────────────────────
# Prerequisites: npm install -g @railway/cli  &&  railway login  &&  railway link

deploy_railway() {
  require_cmd railway "Run: npm install -g @railway/cli && railway login && railway link"
  require_var BOT_TOKEN
  require_var ANTHROPIC_API_KEY
  require_var SUPABASE_URL
  require_var SUPABASE_SERVICE_ROLE_KEY
  require_var REDIS_URL

  log "=== Railway deployment ==="

  # ── Push environment variables ──────────────────────────────────────────────
  # Build the key=value list for required vars
  local -a vars=(
    "BOT_TOKEN=${BOT_TOKEN}"
    "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
    "SUPABASE_URL=${SUPABASE_URL}"
    "SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}"
    "REDIS_URL=${REDIS_URL}"
    "NODE_ENV=production"
    "PORT=3000"
  )

  # Optional vars — only set if present in .env
  is_set WEBHOOK_SECRET         && vars+=("WEBHOOK_SECRET=${WEBHOOK_SECRET}")
  is_set ADMIN_TELEGRAM_ID      && vars+=("ADMIN_TELEGRAM_ID=${ADMIN_TELEGRAM_ID}")
  is_set ANTHROPIC_DAILY_TOKEN_BUDGET && vars+=("ANTHROPIC_DAILY_TOKEN_BUDGET=${ANTHROPIC_DAILY_TOKEN_BUDGET}")

  log "Setting ${#vars[@]} environment variables on Railway…"
  railway variables set "${vars[@]}"

  # ── Deploy ──────────────────────────────────────────────────────────────────
  log "Triggering deploy (this streams build logs)…"
  railway up

  # ── Determine public URL ────────────────────────────────────────────────────
  # Railway auto-generates a domain. Try to detect it; fall back to manual.
  local domain=""
  if domain=$(railway domain 2>/dev/null | grep -Eo 'https://[^[:space:]]+' | head -1); then
    log "Detected Railway domain: $domain"
  fi

  if [[ -z "$domain" ]]; then
    info "Could not auto-detect your Railway domain."
    info "Open the Railway dashboard → your service → Settings → Domains"
    info "Then run:  WEBHOOK_URL=https://<your-domain> ./deploy.sh webhook"
    return 0
  fi

  # Tell the bot its own URL so it can register the webhook on startup
  railway variables set "WEBHOOK_URL=${domain}"

  # ── Health check ────────────────────────────────────────────────────────────
  wait_for_health "${domain}/health"

  # ── Register webhook ────────────────────────────────────────────────────────
  register_webhook "$domain"

  log "=== Railway deployment complete ==="
  info "Service URL: $domain"
  info "Health:      ${domain}/health"
}

# ── Platform: Fly.io ──────────────────────────────────────────────────────────
# Prerequisites: curl -L https://fly.io/install.sh | sh  &&  fly auth login

deploy_fly() {
  require_cmd fly "Install from https://fly.io/docs/hands-on/install-flyctl/"
  require_var BOT_TOKEN
  require_var ANTHROPIC_API_KEY
  require_var SUPABASE_URL
  require_var SUPABASE_SERVICE_ROLE_KEY
  require_var REDIS_URL

  log "=== Fly.io deployment ==="

  local fly_url="https://${FLY_APP}.fly.dev"

  # ── Create app if it doesn't exist ─────────────────────────────────────────
  if ! fly apps list 2>/dev/null | awk '{print $1}' | grep -qx "$FLY_APP"; then
    log "App '${FLY_APP}' not found — creating…"
    fly apps create "$FLY_APP"
  else
    log "App '${FLY_APP}' already exists."
  fi

  # ── Set secrets (Fly's name for env vars) ──────────────────────────────────
  local -a secrets=(
    "BOT_TOKEN=${BOT_TOKEN}"
    "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
    "SUPABASE_URL=${SUPABASE_URL}"
    "SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}"
    "REDIS_URL=${REDIS_URL}"
    "WEBHOOK_URL=${fly_url}"
  )

  is_set WEBHOOK_SECRET         && secrets+=("WEBHOOK_SECRET=${WEBHOOK_SECRET}")
  is_set ADMIN_TELEGRAM_ID      && secrets+=("ADMIN_TELEGRAM_ID=${ADMIN_TELEGRAM_ID}")
  is_set ANTHROPIC_DAILY_TOKEN_BUDGET \
    && secrets+=("ANTHROPIC_DAILY_TOKEN_BUDGET=${ANTHROPIC_DAILY_TOKEN_BUDGET}")

  log "Setting ${#secrets[@]} secrets on Fly…"
  fly secrets set "${secrets[@]}" --app "$FLY_APP" --stage
  # --stage stores secrets without triggering a deploy; we deploy explicitly below

  # ── Build and deploy ────────────────────────────────────────────────────────
  log "Building and deploying to Fly (this may take a few minutes)…"
  fly deploy --app "$FLY_APP" --strategy=immediate

  # ── Health check ────────────────────────────────────────────────────────────
  wait_for_health "${fly_url}/health"

  # ── Register webhook ────────────────────────────────────────────────────────
  # The bot registers the webhook itself on startup via WEBHOOK_URL, but we
  # also call the API directly here to confirm it's set correctly.
  register_webhook "$fly_url"

  log "=== Fly.io deployment complete ==="
  info "Service URL: $fly_url"
  info "Health:      ${fly_url}/health"
  info "Logs:        fly logs --app ${FLY_APP}"
  info "SSH:         fly ssh console --app ${FLY_APP}"
}

# ── Subcommand: webhook only ─────────────────────────────────────────────────

deploy_webhook_only() {
  require_var BOT_TOKEN
  require_var WEBHOOK_URL "Set WEBHOOK_URL=https://<your-domain> in .env"

  log "=== Re-registering Telegram webhook only ==="
  wait_for_health "${WEBHOOK_URL}/health"
  register_webhook "$WEBHOOK_URL"
}

# ── Usage ─────────────────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'

Usage: ./deploy.sh <platform>

  railway   Deploy to Railway.app
              Prerequisites: npm install -g @railway/cli
                             railway login
                             railway link   (link to your Railway project)

  fly       Deploy to Fly.io
              Prerequisites: curl -L https://fly.io/install.sh | sh
                             fly auth login

  webhook   Re-register the Telegram webhook without redeploying.
              Requires WEBHOOK_URL to be set in .env.

Environment:
  All secrets are read from .env (default) or the file named by $ENV_FILE.
  Required:  BOT_TOKEN, ANTHROPIC_API_KEY, SUPABASE_URL,
             SUPABASE_SERVICE_ROLE_KEY, REDIS_URL
  Optional:  WEBHOOK_SECRET, ADMIN_TELEGRAM_ID,
             ANTHROPIC_DAILY_TOKEN_BUDGET

EOF
  exit 1
}

# ── Main ──────────────────────────────────────────────────────────────────────

case "$PLATFORM" in
  railway)
    load_env
    deploy_railway
    ;;
  fly)
    load_env
    deploy_fly
    ;;
  webhook)
    load_env
    deploy_webhook_only
    ;;
  *)
    usage
    ;;
esac

log "Done!"
