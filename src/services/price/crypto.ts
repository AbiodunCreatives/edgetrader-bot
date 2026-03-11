/**
 * Live crypto price fetcher.
 *
 * Primary:  CoinGecko free API (no auth required)
 * Fallback: Binance spot ticker (no auth required)
 *
 * Supported assets are mapped from common ticker / name variants to the
 * canonical CoinGecko ID used in API requests.
 */

// ── Asset registry ──────────────────────────────────────────────────────────

interface AssetDef {
  coinGeckoId: string;
  binanceSymbol: string;
  /** Human-readable label used in prompts. */
  label: string;
}

const ASSETS: Record<string, AssetDef> = {
  bitcoin:  { coinGeckoId: "bitcoin",  binanceSymbol: "BTCUSDT",  label: "Bitcoin (BTC)" },
  btc:      { coinGeckoId: "bitcoin",  binanceSymbol: "BTCUSDT",  label: "Bitcoin (BTC)" },
  ethereum: { coinGeckoId: "ethereum", binanceSymbol: "ETHUSDT",  label: "Ethereum (ETH)" },
  eth:      { coinGeckoId: "ethereum", binanceSymbol: "ETHUSDT",  label: "Ethereum (ETH)" },
  solana:   { coinGeckoId: "solana",   binanceSymbol: "SOLUSDT",  label: "Solana (SOL)" },
  sol:      { coinGeckoId: "solana",   binanceSymbol: "SOLUSDT",  label: "Solana (SOL)" },
};

// ── Result type ─────────────────────────────────────────────────────────────

export interface LivePrice {
  asset: string;         // e.g. "Bitcoin (BTC)"
  coinGeckoId: string;
  price: number;
  source: "coingecko" | "binance";
  fetchedAt: string;     // ISO-8601 UTC timestamp
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fromCoinGecko(coinGeckoId: string): Promise<number> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoId}&vs_currencies=usd`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as Record<string, { usd: number }>;
  const price = json[coinGeckoId]?.usd;
  if (!price || price <= 0) throw new Error(`CoinGecko returned invalid price for ${coinGeckoId}`);
  return price;
}

async function fromBinance(binanceSymbol: string): Promise<number> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { price: string };
  const price = parseFloat(json.price);
  if (!price || price <= 0) throw new Error(`Binance returned invalid price for ${binanceSymbol}`);
  return price;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a ticker/name string (e.g. "BTC", "bitcoin", "Ethereum") to an
 * AssetDef. Returns null if the asset is not in the registry.
 */
export function resolveAsset(ticker: string): AssetDef | null {
  return ASSETS[ticker.toLowerCase()] ?? null;
}

/**
 * Fetch a live spot price for a known crypto asset.
 * Tries CoinGecko first; falls back to Binance on any error.
 * Throws if both sources fail.
 */
export async function fetchLivePrice(asset: AssetDef): Promise<LivePrice> {
  const fetchedAt = new Date().toISOString();

  // Primary: CoinGecko
  try {
    const price = await fromCoinGecko(asset.coinGeckoId);
    return { asset: asset.label, coinGeckoId: asset.coinGeckoId, price, source: "coingecko", fetchedAt };
  } catch (cgErr) {
    console.warn(`[price] CoinGecko failed (${(cgErr as Error).message}), trying Binance…`);
  }

  // Fallback: Binance
  try {
    const price = await fromBinance(asset.binanceSymbol);
    return { asset: asset.label, coinGeckoId: asset.coinGeckoId, price, source: "binance", fetchedAt };
  } catch (binErr) {
    throw new Error(
      `Unable to fetch live price for ${asset.label}. ` +
      `CoinGecko and Binance both failed. Analysis aborted.`
    );
  }
}

// ── Question parser ──────────────────────────────────────────────────────────

/**
 * Detect whether a market question mentions a known crypto asset.
 * Returns the AssetDef if found, null otherwise.
 *
 * Examples that match:
 *   "Will BTC reach $150,000 by end of 2025?"
 *   "Bitcoin above all-time high in Q1 2026?"
 *   "ETH price exceeds $10,000?"
 *   "Solana dominance in 2025?"
 */
export function detectCryptoAsset(question: string): AssetDef | null {
  const q = question.toLowerCase();
  const assetKey = Object.keys(ASSETS).find((k) => {
    const re = new RegExp(`\\b${k}\\b`);
    return re.test(q);
  });
  return assetKey ? (ASSETS[assetKey] ?? null) : null;
}

/**
 * Extract a dollar price target from a market question if present.
 * Returns null if no recognisable price target is found.
 *
 * Handles: $150k, $1,000,000, $2.5M, $99000
 */
export function parseTargetPrice(question: string): number | null {
  const priceMatch = question.match(/\$[\d,]+(?:\.\d+)?(?:[kKmM])?/);
  if (!priceMatch) return null;

  const raw = priceMatch[0].replace(/[$,]/g, "");
  let targetPrice: number;

  if (/[kK]$/.test(raw)) {
    targetPrice = parseFloat(raw) * 1_000;
  } else if (/[mM]$/.test(raw)) {
    targetPrice = parseFloat(raw) * 1_000_000;
  } else {
    targetPrice = parseFloat(raw);
  }

  return isFinite(targetPrice) && targetPrice > 0 ? targetPrice : null;
}
