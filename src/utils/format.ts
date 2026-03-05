/**
 * Telegram message formatting helpers.
 * Uses HTML parse mode for rich formatting.
 */

export function bold(text: string) {
  return `<b>${escapeHtml(text)}</b>`;
}

export function italic(text: string) {
  return `<i>${escapeHtml(text)}</i>`;
}

export function code(text: string) {
  return `<code>${escapeHtml(text)}</code>`;
}

export function pre(text: string) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

export function link(text: string, url: string) {
  return `<a href="${url}">${escapeHtml(text)}</a>`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format a probability (0–1) as a percentage string */
export function formatProbability(p: number | null | undefined): string {
  if (p == null) return "N/A";
  return `${(p * 100).toFixed(1)}%`;
}

/** Format a market volume */
export function formatVolume(amount: number | null | undefined): string {
  if (amount == null) return "N/A";
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
}

/** Format a Unix timestamp or ISO string as a readable date */
export function formatDate(date: string | number | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** Format a date/time as relative time (e.g., "2 hours ago" / "in 3 days"). */
export function formatRelativeTime(date: string | number | Date): string {
  const target = new Date(date).getTime();
  const now = Date.now();
  const diffMs = target - now;
  const abs = Math.abs(diffMs);

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  const formatUnit = (value: number, unit: string) => `${value} ${unit}${value !== 1 ? "s" : ""}`;

  let text: string;
  if (abs < hour) {
    text = formatUnit(Math.round(abs / minute) || 1, "minute");
  } else if (abs < day) {
    text = formatUnit(Math.round(abs / hour), "hour");
  } else {
    text = formatUnit(Math.round(abs / day), "day");
  }

  return diffMs >= 0 ? `in ${text}` : `${text} ago`;
}

/** Returns a trend arrow based on price change */
export function trendArrow(change: number): string {
  if (change > 0.02) return "🟢↑";
  if (change < -0.02) return "🔴↓";
  return "⚪→";
}

/** Build a visual probability bar */
export function probBar(p: number | null | undefined, width = 10): string {
  const filled = Math.round((p ?? 0) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Format a large integer count with K/M suffix */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Standard error message for users */
export function errorMessage(msg: string): string {
  return `❌ ${escapeHtml(msg)}`;
}

/** Standard success message */
export function successMessage(msg: string): string {
  return `✅ ${escapeHtml(msg)}`;
}
