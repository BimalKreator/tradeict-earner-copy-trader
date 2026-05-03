/**
 * Cosmic (USD-quoted) → Delta Exchange (USDT swap) symbol mapping (India / ccxt).
 * Canonical map:
 * {"AAVEUSD":"AAVEUSDT","AVAXUSD":"AVAXUSDT","BNBUSD":"BNBUSDT","DOGEUSD":"DOGEUSDT",
 *  "ETHUSD":"ETHUSDT","LTCUSD":"LTCUSDT","SOLUSD":"SOLUSDT"}
 */
export declare const COSMIC_TO_DELTA_SYMBOL: Readonly<Record<string, string>>;
/** Normalize labels like "ETH/USD", "eth-usd" → "ETHUSD" for lookup. */
export declare function normalizeCosmicSymbolKey(raw: string): string;
export declare function mapCosmicSymbolToDelta(cosmicSymbol: string): string | null;
//# sourceMappingURL=cosmicSymbolMap.d.ts.map