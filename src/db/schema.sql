-- ============================================================
-- Edge Trader Bot — Full Supabase Postgres Schema
-- Run this in the Supabase SQL editor (or via psql).
-- ============================================================

-- Enable pgcrypto for gen_random_uuid() on older PG versions
-- (Supabase already ships with it enabled)
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id   BIGINT      NOT NULL UNIQUE,
  username      TEXT,
  tier          TEXT        NOT NULL DEFAULT 'free'
                            CHECK (tier IN ('free', 'pro', 'whale')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  users              IS 'Registered bot users, keyed by Telegram ID.';
COMMENT ON COLUMN users.telegram_id  IS 'Telegram numeric user ID (immutable).';
COMMENT ON COLUMN users.tier        IS 'Subscription tier: free | pro | whale.';

-- ============================================================
-- 2. MARKETS_CACHE
-- ============================================================

CREATE TABLE IF NOT EXISTS markets_cache (
  id           TEXT        PRIMARY KEY,           -- market ID from the source platform
  source       TEXT        NOT NULL               -- 'polymarket' | 'bayse'
                           CHECK (source IN ('polymarket', 'bayse')),
  question     TEXT        NOT NULL,
  probability  NUMERIC(8, 6),                     -- 0.000000 – 1.000000
  volume       NUMERIC(18, 2),
  last_price   NUMERIC(8, 6),
  end_date     TIMESTAMPTZ,
  category     TEXT,
  url          TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_data     JSONB
);

COMMENT ON TABLE  markets_cache            IS 'Short-lived cache of market data fetched from external APIs.';
COMMENT ON COLUMN markets_cache.id         IS 'Native market ID from the upstream platform.';
COMMENT ON COLUMN markets_cache.raw_data   IS 'Full upstream API response for fields not yet normalised.';

-- ============================================================
-- 3. ALERTS
-- ============================================================

CREATE TABLE IF NOT EXISTS alerts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  market_id   TEXT        NOT NULL,
  condition   TEXT        NOT NULL
              CHECK (condition IN ('above', 'below', 'volume_spike')),
  threshold   NUMERIC(18, 6) NOT NULL,
  triggered   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN alerts.condition  IS 'Trigger logic: above/below a probability, or a volume spike.';
COMMENT ON COLUMN alerts.threshold  IS 'Probability (0–1) or volume amount depending on condition.';
COMMENT ON COLUMN alerts.triggered  IS 'Set to TRUE once the alert has fired; prevents repeat fires.';

-- ============================================================
-- 4. PORTFOLIO
-- ============================================================

CREATE TABLE IF NOT EXISTS portfolio (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  market_id    TEXT        NOT NULL,
  position     TEXT
               CHECK (position IN ('yes', 'no')),
  entry_price  NUMERIC(8, 6),                     -- 0.000000 – 1.000000
  quantity     NUMERIC(18, 6),
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN portfolio.position     IS 'Side of the bet: yes | no.';
COMMENT ON COLUMN portfolio.entry_price  IS 'Implied probability at time of entry.';

-- ============================================================
-- 5. GAME_SESSIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS game_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id          BIGINT      NOT NULL,           -- Telegram group chat ID
  market_id        TEXT        NOT NULL,
  market_question  TEXT,
  status           TEXT        NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'resolved')),
  correct_outcome  TEXT,                           -- populated on resolution
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

COMMENT ON TABLE  game_sessions                  IS 'One prediction-game round tied to a Telegram group chat.';
COMMENT ON COLUMN game_sessions.chat_id          IS 'Telegram group/supergroup numeric chat ID.';
COMMENT ON COLUMN game_sessions.correct_outcome  IS 'The verified resolution value; NULL until resolved.';

-- ============================================================
-- 6. VOTES
-- ============================================================

CREATE TABLE IF NOT EXISTS votes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  prediction  TEXT        NOT NULL
              CHECK (prediction IN ('yes', 'no')),
  confidence  INTEGER
              CHECK (confidence BETWEEN 1 AND 100),
  voted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (session_id, user_id)               -- one vote per user per game
);

COMMENT ON COLUMN votes.confidence  IS 'Self-reported confidence 1–100; used for Brier scoring.';

-- ============================================================
-- 7. INDEXES
-- ============================================================

-- users
CREATE INDEX IF NOT EXISTS idx_users_telegram_id
  ON users (telegram_id);

-- markets_cache
CREATE INDEX IF NOT EXISTS idx_markets_cache_source
  ON markets_cache (source);
CREATE INDEX IF NOT EXISTS idx_markets_cache_updated_at
  ON markets_cache (updated_at);

-- alerts
CREATE INDEX IF NOT EXISTS idx_alerts_user_id
  ON alerts (user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_market_id
  ON alerts (market_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user_triggered
  ON alerts (user_id, triggered)             -- alert-checker hot path
  WHERE triggered = FALSE;

-- portfolio
CREATE INDEX IF NOT EXISTS idx_portfolio_user_id
  ON portfolio (user_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_market_id
  ON portfolio (market_id);

-- game_sessions
CREATE INDEX IF NOT EXISTS idx_game_sessions_chat_id
  ON game_sessions (chat_id);
CREATE INDEX IF NOT EXISTS idx_game_sessions_market_id
  ON game_sessions (market_id);
CREATE INDEX IF NOT EXISTS idx_game_sessions_status
  ON game_sessions (status)
  WHERE status = 'active';

-- votes
CREATE INDEX IF NOT EXISTS idx_votes_session_id
  ON votes (session_id);
CREATE INDEX IF NOT EXISTS idx_votes_user_id
  ON votes (user_id);

-- ============================================================
-- 8. LEADERBOARD MATERIALIZED VIEW
--    Ranked per (chat_id, user_id) across all resolved games.
--    Refresh with: REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard;
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard AS
WITH resolved_votes AS (
  -- Join votes to resolved game sessions
  SELECT
    gs.chat_id,
    v.user_id,
    v.prediction,
    v.confidence,
    gs.correct_outcome,
    (v.prediction = gs.correct_outcome)               AS is_correct
  FROM votes           v
  JOIN game_sessions   gs ON gs.id = v.session_id
  WHERE gs.status = 'resolved'
    AND gs.correct_outcome IS NOT NULL
),
aggregated AS (
  SELECT
    chat_id,
    user_id,
    COUNT(*)                                          AS total_votes,
    SUM(is_correct::INT)                              AS correct_count,
    ROUND(
      100.0 * SUM(is_correct::INT) / NULLIF(COUNT(*), 0),
      2
    )                                                 AS accuracy_pct,
    -- Brier score per vote: (p/100 - outcome)^2, lower is better
    ROUND(
      AVG(
        POWER(
          (COALESCE(confidence, 50)::NUMERIC / 100)
          - (is_correct::INT),
          2
        )
      )::NUMERIC,
      4
    )                                                 AS avg_brier_score
  FROM resolved_votes
  GROUP BY chat_id, user_id
),
streaks AS (
  -- Current win/loss streak: count consecutive correct predictions
  -- ordered by game creation time (most recent first)
  SELECT
    gs.chat_id,
    v.user_id,
    -- Walk backwards from the latest vote; stop at first miss
    SUM(
      CASE WHEN (v.prediction = gs.correct_outcome) THEN 1 ELSE 0 END
    )
    FILTER (
      WHERE gs.resolved_at >= (
        SELECT COALESCE(MAX(gs2.resolved_at), '1970-01-01'::TIMESTAMPTZ)
        FROM votes          v2
        JOIN game_sessions  gs2 ON gs2.id = v2.session_id
        WHERE v2.user_id       = v.user_id
          AND gs2.chat_id      = gs.chat_id
          AND gs2.status       = 'resolved'
          AND v2.prediction   <> gs2.correct_outcome
          AND gs2.resolved_at <= gs.resolved_at
      )
    )                                                 AS current_streak
  FROM votes          v
  JOIN game_sessions  gs ON gs.id = v.session_id
  WHERE gs.status = 'resolved'
    AND gs.correct_outcome IS NOT NULL
  GROUP BY gs.chat_id, v.user_id
)
SELECT
  a.chat_id,
  a.user_id,
  u.telegram_id,
  u.username,
  a.correct_count,
  a.total_votes,
  a.accuracy_pct,
  a.avg_brier_score,
  COALESCE(s.current_streak, 0)                      AS current_streak,
  RANK() OVER (
    PARTITION BY a.chat_id
    ORDER BY a.accuracy_pct DESC, a.correct_count DESC
  )                                                   AS rank
FROM aggregated  a
JOIN users       u ON u.id = a.user_id
LEFT JOIN streaks s ON s.chat_id = a.chat_id AND s.user_id = a.user_id;

-- Unique index required for REFRESH CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_chat_user
  ON leaderboard (chat_id, user_id);

COMMENT ON MATERIALIZED VIEW leaderboard IS
  'Per-chat accuracy rankings. Refresh after each game resolution.';

-- ============================================================
-- 9. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio      ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes          ENABLE ROW LEVEL SECURITY;
-- markets_cache is public read, service-role write — no RLS needed.

-- Helper: resolve the app user's UUID from their Telegram ID stored in the JWT.
-- The bot sets `request.jwt.claims.telegram_id` via the service-role key, so
-- anon/authenticated clients can only access their own rows.

-- USERS: each user reads/updates only their own row
DROP POLICY IF EXISTS users_select_own ON users;
CREATE POLICY users_select_own ON users
  FOR SELECT USING (telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT);

DROP POLICY IF EXISTS users_update_own ON users;
CREATE POLICY users_update_own ON users
  FOR UPDATE USING (telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT);

-- ALERTS: scoped to the owning user
DROP POLICY IF EXISTS alerts_select_own ON alerts;
CREATE POLICY alerts_select_own ON alerts
  FOR SELECT USING (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

DROP POLICY IF EXISTS alerts_insert_own ON alerts;
CREATE POLICY alerts_insert_own ON alerts
  FOR INSERT WITH CHECK (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

DROP POLICY IF EXISTS alerts_update_own ON alerts;
CREATE POLICY alerts_update_own ON alerts
  FOR UPDATE USING (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

DROP POLICY IF EXISTS alerts_delete_own ON alerts;
CREATE POLICY alerts_delete_own ON alerts
  FOR DELETE USING (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

-- PORTFOLIO: scoped to the owning user
DROP POLICY IF EXISTS portfolio_select_own ON portfolio;
CREATE POLICY portfolio_select_own ON portfolio
  FOR SELECT USING (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

DROP POLICY IF EXISTS portfolio_insert_own ON portfolio;
CREATE POLICY portfolio_insert_own ON portfolio
  FOR INSERT WITH CHECK (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

DROP POLICY IF EXISTS portfolio_update_own ON portfolio;
CREATE POLICY portfolio_update_own ON portfolio
  FOR UPDATE USING (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

DROP POLICY IF EXISTS portfolio_delete_own ON portfolio;
CREATE POLICY portfolio_delete_own ON portfolio
  FOR DELETE USING (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

-- GAME_SESSIONS: readable by all authenticated users in the same chat;
-- only the service role can insert/resolve (the bot backend does this).
DROP POLICY IF EXISTS game_sessions_select_all ON game_sessions;
CREATE POLICY game_sessions_select_all ON game_sessions
  FOR SELECT USING (TRUE);

-- VOTES: users can read all votes in a session, but write only their own
DROP POLICY IF EXISTS votes_select_all ON votes;
CREATE POLICY votes_select_all ON votes
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS votes_insert_own ON votes;
CREATE POLICY votes_insert_own ON votes
  FOR INSERT WITH CHECK (user_id = (SELECT id FROM users WHERE telegram_id = (current_setting('request.jwt.claims', TRUE)::jsonb ->> 'telegram_id')::BIGINT));

-- ============================================================
-- 10. HELPER FUNCTION: upsert_user
--     Called by the bot on every interaction to ensure the user exists.
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_user(
  p_telegram_id BIGINT,
  p_username    TEXT DEFAULT NULL
)
RETURNS users AS $$
DECLARE
  v_user users;
BEGIN
  INSERT INTO users (telegram_id, username)
  VALUES (p_telegram_id, p_username)
  ON CONFLICT (telegram_id) DO UPDATE
    SET username = COALESCE(EXCLUDED.username, users.username)
  RETURNING * INTO v_user;
  RETURN v_user;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION upsert_user IS
  'Idempotently registers a Telegram user and returns their full row.';

-- ============================================================
-- 11. HELPER FUNCTION: refresh_leaderboard
--     Wraps REFRESH MATERIALIZED VIEW CONCURRENTLY so it can
--     be called as a Supabase RPC from the bot backend.
-- ============================================================

CREATE OR REPLACE FUNCTION refresh_leaderboard()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION refresh_leaderboard IS
  'Refreshes the leaderboard materialized view. Call after each game resolution.';
