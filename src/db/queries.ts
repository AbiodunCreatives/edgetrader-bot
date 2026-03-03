import { supabase } from "./client.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  telegram_id: number;
  username: string | null;
  tier: "free" | "pro" | "whale";
  created_at: string;
}

export interface DbAlert {
  id: string;
  user_id: string;
  market_id: string;
  condition: "above" | "below" | "volume_spike";
  threshold: number;
  triggered: boolean;
  created_at: string;
}

export interface DbPortfolioEntry {
  id: string;
  user_id: string;
  market_id: string;
  position: "yes" | "no" | null;
  entry_price: number | null;
  quantity: number | null;
  added_at: string;
}

export interface DbGameSession {
  id: string;
  chat_id: number;
  market_id: string;
  market_question: string | null;
  status: "active" | "resolved";
  correct_outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface DbVote {
  id: string;
  session_id: string;
  user_id: string;
  prediction: "yes" | "no";
  confidence: number | null;
  voted_at: string;
}

export interface DbMarketCache {
  id: string;
  source: "polymarket" | "bayse";
  question: string;
  probability: number | null;
  volume: number | null;
  last_price: number | null;
  end_date: string | null;
  category: string | null;
  url: string | null;
  updated_at: string;
  raw_data: unknown;
}

// ── Users ──────────────────────────────────────────────────────────────────

/** Upsert a user via the SQL helper function, returns the full row. */
export async function upsertUser(telegramId: number, username?: string): Promise<DbUser> {
  const { data, error } = await supabase
    .rpc("upsert_user", { p_telegram_id: telegramId, p_username: username ?? null });
  if (error) throw error;
  return data as DbUser;
}

export async function getUserByTelegramId(telegramId: number): Promise<DbUser | null> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return (data as DbUser) ?? null;
}

export async function setUserTier(userId: string, tier: DbUser["tier"]): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ tier })
    .eq("id", userId);
  if (error) throw error;
}

// ── Markets Cache ──────────────────────────────────────────────────────────

export async function upsertMarketCache(market: Omit<DbMarketCache, "updated_at">): Promise<void> {
  const { error } = await supabase
    .from("markets_cache")
    .upsert({ ...market, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw error;
}

export async function getMarketCache(marketId: string): Promise<DbMarketCache | null> {
  const { data, error } = await supabase
    .from("markets_cache")
    .select("*")
    .eq("id", marketId)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return (data as DbMarketCache) ?? null;
}

// ── Alerts ─────────────────────────────────────────────────────────────────

export async function createAlert(alert: {
  user_id: string;
  market_id: string;
  condition: DbAlert["condition"];
  threshold: number;
}): Promise<DbAlert> {
  const { data, error } = await supabase
    .from("alerts")
    .insert(alert)
    .select()
    .single();
  if (error) throw error;
  return data as DbAlert;
}

/** Returns all alerts that haven't fired yet — used by the scheduler. */
export async function getActiveAlerts(): Promise<DbAlert[]> {
  const { data, error } = await supabase
    .from("alerts")
    .select("*")
    .eq("triggered", false);
  if (error) throw error;
  return (data ?? []) as DbAlert[];
}

/**
 * Like getActiveAlerts but joins the owning user so the scheduler gets
 * the telegram_id in one query instead of N+1 lookups.
 */
export interface DbAlertWithUser extends DbAlert {
  telegram_id: number;
  user_tier: DbUser["tier"];
}

export async function getActiveAlertsWithUsers(): Promise<DbAlertWithUser[]> {
  const { data, error } = await supabase
    .from("alerts")
    .select("*, users(telegram_id, tier)")
    .eq("triggered", false);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const r = row as DbAlert & { users: { telegram_id: number; tier: string } | null };
    return {
      id: r.id,
      user_id: r.user_id,
      market_id: r.market_id,
      condition: r.condition,
      threshold: r.threshold,
      triggered: r.triggered,
      created_at: r.created_at,
      telegram_id: r.users?.telegram_id ?? 0,
      user_tier: (r.users?.tier ?? "free") as DbUser["tier"],
    };
  });
}

/** Fetch all users whose tier is in the provided list. Used for broadcast sends. */
export async function getUsersByTier(tiers: Array<DbUser["tier"]>): Promise<DbUser[]> {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .in("tier", tiers);
  if (error) throw error;
  return (data ?? []) as DbUser[];
}

export async function getUserAlerts(userId: string): Promise<DbAlert[]> {
  const { data, error } = await supabase
    .from("alerts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DbAlert[];
}

export async function markAlertTriggered(alertId: string): Promise<void> {
  const { error } = await supabase
    .from("alerts")
    .update({ triggered: true })
    .eq("id", alertId);
  if (error) throw error;
}

export async function deleteAlert(userId: string, alertId: string): Promise<void> {
  const { error } = await supabase
    .from("alerts")
    .delete()
    .eq("id", alertId)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Portfolio ──────────────────────────────────────────────────────────────

export async function getPortfolio(userId: string): Promise<DbPortfolioEntry[]> {
  const { data, error } = await supabase
    .from("portfolio")
    .select("*")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DbPortfolioEntry[];
}

export async function addPortfolioEntry(entry: {
  user_id: string;
  market_id: string;
  position: "yes" | "no";
  entry_price?: number;
  quantity?: number;
}): Promise<DbPortfolioEntry> {
  const { data, error } = await supabase
    .from("portfolio")
    .insert(entry)
    .select()
    .single();
  if (error) throw error;
  return data as DbPortfolioEntry;
}

export async function deletePortfolioEntry(userId: string, entryId: string): Promise<void> {
  const { error } = await supabase
    .from("portfolio")
    .delete()
    .eq("id", entryId)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Game Sessions ──────────────────────────────────────────────────────────

export async function createGameSession(session: {
  chat_id: number;
  market_id: string;
  market_question?: string;
}): Promise<DbGameSession> {
  const { data, error } = await supabase
    .from("game_sessions")
    .insert(session)
    .select()
    .single();
  if (error) throw error;
  return data as DbGameSession;
}

export async function getActiveGameSessions(chatId: number): Promise<DbGameSession[]> {
  const { data, error } = await supabase
    .from("game_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DbGameSession[];
}

export async function resolveGameSession(
  sessionId: string,
  correctOutcome: string
): Promise<void> {
  const { error } = await supabase
    .from("game_sessions")
    .update({
      status: "resolved",
      correct_outcome: correctOutcome,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}

// ── Votes ──────────────────────────────────────────────────────────────────

export async function castVote(vote: {
  session_id: string;
  user_id: string;
  prediction: "yes" | "no";
  confidence?: number;
}): Promise<DbVote> {
  const { data, error } = await supabase
    .from("votes")
    .upsert(vote, { onConflict: "session_id,user_id" })
    .select()
    .single();
  if (error) throw error;
  return data as DbVote;
}

export async function getSessionVotes(
  sessionId: string
): Promise<Array<DbVote & { users: Pick<DbUser, "username" | "telegram_id"> }>> {
  const { data, error } = await supabase
    .from("votes")
    .select("*, users(username, telegram_id)")
    .eq("session_id", sessionId);
  if (error) throw error;
  return (data ?? []) as Array<DbVote & { users: Pick<DbUser, "username" | "telegram_id"> }>;
}

// ── Leaderboard ────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  chat_id: number;
  user_id: string;
  telegram_id: number;
  username: string | null;
  correct_count: number;
  total_votes: number;
  accuracy_pct: number;
  avg_brier_score: number;
  current_streak: number;
  rank: number;
}

export async function getLeaderboard(chatId: number, limit = 10): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase
    .from("leaderboard")
    .select("*")
    .eq("chat_id", chatId)
    .order("rank", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LeaderboardEntry[];
}

/** Call this after resolving a game session to keep the view current. */
export async function refreshLeaderboard(): Promise<void> {
  const { error } = await supabase.rpc("refresh_leaderboard");
  // This RPC wraps: REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard;
  // If it doesn't exist yet, silently ignore — manual refresh still works.
  if (error && !error.message.includes("does not exist")) throw error;
}
