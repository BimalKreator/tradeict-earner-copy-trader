/**
 * Cosmic (USD-quoted) → Delta Exchange (USDT swap) symbol mapping (India / ccxt).
 */
export declare const COSMIC_TO_DELTA_SYMBOL: Readonly<Record<string, string>>;
/** Normalize labels like "ETH/USD", "eth-usd" → "ETHUSD" for lookup. */
export declare function normalizeCosmicSymbolKey(raw: string): string;
export declare function mapCosmicSymbolToDelta(cosmicSymbol: string): string | null;
//# sourceMappingURL=cosmicSymbolMap.d.ts.map