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

/** Standard error message for users */
export function errorMessage(msg: string): string {
  return `❌ ${escapeHtml(msg)}`;
}

/** Standard success message */
export function successMessage(msg: string): string {
  return `✅ ${escapeHtml(msg)}`;
}
