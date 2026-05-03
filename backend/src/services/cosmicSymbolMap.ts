/**
 * Cosmic (USD-quoted) → Delta Exchange (USDT swap) symbol mapping (India / ccxt).
 * Canonical map:
 * {"AAVEUSD":"AAVEUSDT","AVAXUSD":"AVAXUSDT","BNBUSD":"BNBUSDT","DOGEUSD":"DOGEUSDT",
 *  "ETHUSD":"ETHUSDT","LTCUSD":"LTCUSDT","SOLUSD":"SOLUSDT"}
 */
export const COSMIC_TO_DELTA_SYMBOL: Readonly<Record<string, string>> = {
  AAVEUSD: "AAVEUSDT",
  AVAXUSD: "AVAXUSDT",
  BNBUSD: "BNBUSDT",
  DOGEUSD: "DOGEUSDT",
  ETHUSD: "ETHUSDT",
  LTCUSD: "LTCUSDT",
  SOLUSD: "SOLUSDT",
} as const;

/** Normalize labels like "ETH/USD", "eth-usd" → "ETHUSD" for lookup. */
export function normalizeCosmicSymbolKey(raw: string): string {
  return raw.replace(/[/\s_-]/g, "").toUpperCase();
}

export function mapCosmicSymbolToDelta(cosmicSymbol: string): string | null {
  const key = normalizeCosmicSymbolKey(cosmicSymbol);
  return COSMIC_TO_DELTA_SYMBOL[key] ?? null;
}
