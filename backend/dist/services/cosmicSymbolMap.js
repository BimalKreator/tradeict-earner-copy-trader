/**
 * Cosmic (USD-quoted) → Delta Exchange (USDT swap) symbol mapping (India / ccxt).
 * Canonical map:
 * {"AAVEUSD":"AAVEUSDT","AVAXUSD":"AVAXUSDT","BNBUSD":"BNBUSDT","DOGEUSD":"DOGEUSDT",
 *  "ETHUSD":"ETHUSDT","LTCUSD":"LTCUSDT","SOLUSD":"SOLUSDT"}
 */
export const COSMIC_TO_DELTA_SYMBOL = {
    AAVEUSD: "AAVEUSDT",
    AVAXUSD: "AVAXUSDT",
    BNBUSD: "BNBUSDT",
    DOGEUSD: "DOGEUSDT",
    ETHUSD: "ETHUSDT",
    LTCUSD: "LTCUSDT",
    SOLUSD: "SOLUSDT",
};
/** Normalize labels like "ETH/USD", "eth-usd" → "ETHUSD" for lookup. */
export function normalizeCosmicSymbolKey(raw) {
    return raw.replace(/[/\s_-]/g, "").toUpperCase();
}
export function mapCosmicSymbolToDelta(cosmicSymbol) {
    const key = normalizeCosmicSymbolKey(cosmicSymbol);
    return COSMIC_TO_DELTA_SYMBOL[key] ?? null;
}
//# sourceMappingURL=cosmicSymbolMap.js.map