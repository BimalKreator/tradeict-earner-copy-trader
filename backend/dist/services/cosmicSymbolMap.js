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
    const mapped = COSMIC_TO_DELTA_SYMBOL[key];
    if (mapped)
        return mapped;
    // Already Delta-style perpetual quote on Cosmic
    if (/^[A-Z0-9]{2,}USDT$/i.test(key))
        return key.toUpperCase();
    // Cosmic USD-quoted pair → Delta USDT swap (same base); avoids dropping trades when the pair is not listed explicitly above
    const usdBase = key.match(/^([A-Z0-9]{2,})USD$/i);
    if (usdBase)
        return `${usdBase[1].toUpperCase()}USDT`;
    return null;
}
//# sourceMappingURL=cosmicSymbolMap.js.map